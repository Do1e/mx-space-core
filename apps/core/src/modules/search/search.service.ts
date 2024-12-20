import algoliasearch from 'algoliasearch'
import removeMdCodeblock from 'remove-md-codeblock'
import type { SearchResponse } from '@algolia/client-search'
import type { SearchDto } from '~/modules/search/search.dto'
import type { Pagination } from '~/shared/interface/paginator.interface'

import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { CronExpression } from '@nestjs/schedule'

import { CronDescription } from '~/common/decorators/cron-description.decorator'
import { CronOnce } from '~/common/decorators/cron-once.decorator'
import { BusinessEvents } from '~/constants/business-event.constant'
import { EventBusEvents } from '~/constants/event-bus.constant'
import { DatabaseService } from '~/processors/database/database.service'
import { transformDataToPaginate } from '~/transformers/paginate.transformer'

import { ConfigsService } from '../configs/configs.service'
import { NoteService } from '../note/note.service'
import { PageService } from '../page/page.service'
import { PostService } from '../post/post.service'

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name)
  constructor(
    @Inject(forwardRef(() => NoteService))
    private readonly noteService: NoteService,

    @Inject(forwardRef(() => PostService))
    private readonly postService: PostService,

    @Inject(forwardRef(() => PageService))
    private readonly pageService: PageService,

    private readonly configs: ConfigsService,
    private readonly databaseService: DatabaseService,
  ) {}

  async searchNote(searchOption: SearchDto, showHidden: boolean) {
    const { keyword, page, size } = searchOption
    const select = '_id title created modified nid'

    const keywordArr = keyword
      .split(/\s+/)
      .map((item) => new RegExp(String(item), 'gi'))

    return transformDataToPaginate(
      await this.noteService.model.paginate(
        {
          $or: [{ title: { $in: keywordArr } }, { text: { $in: keywordArr } }],
          $and: [
            { password: { $not: null } },
            { hide: { $in: showHidden ? [false, true] : [false] } },
            {
              $or: [
                { publicAt: { $not: null } },
                { publicAt: { $lte: new Date() } },
              ],
            },
          ],
        },
        {
          limit: size,
          page,
          select,
        },
      ),
    )
  }

  async searchPost(searchOption: SearchDto) {
    const { keyword, page, size } = searchOption
    const select = '_id title created modified categoryId slug'
    const keywordArr = keyword
      .split(/\s+/)
      .map((item) => new RegExp(String(item), 'gi'))
    return await this.postService.model.paginate(
      {
        $or: [{ title: { $in: keywordArr } }, { text: { $in: keywordArr } }],
      },
      {
        limit: size,
        page,
        select,
      },
    )
  }

  public async getAlgoliaSearchIndex() {
    const { algoliaSearchOptions } = await this.configs.waitForConfigReady()
    if (!algoliaSearchOptions.enable) {
      throw new BadRequestException('algolia not enable.')
    }
    if (
      !algoliaSearchOptions.appId ||
      !algoliaSearchOptions.apiKey ||
      !algoliaSearchOptions.indexName
    ) {
      throw new BadRequestException('algolia not config.')
    }
    const client = algoliasearch(
      algoliaSearchOptions.appId,
      algoliaSearchOptions.apiKey,
    )
    const index = client.initIndex(algoliaSearchOptions.indexName)
    return index
  }

  async searchAlgolia(searchOption: SearchDto): Promise<
    | SearchResponse<{
        id: string
        text: string
        title: string
        type: 'post' | 'note' | 'page'
      }>
    | (Pagination<any> & {
        raw: SearchResponse<{
          id: string
          text: string
          title: string
          type: 'post' | 'note' | 'page'
        }>
      })
  > {
    const { keyword, size, page } = searchOption
    const index = await this.getAlgoliaSearchIndex()

    const search = await index.search<{
      id: string
      text: string
      title: string
      type: 'post' | 'note' | 'page'
    }>(keyword, {
      // start with 0
      page: page - 1,
      hitsPerPage: size,
      attributesToRetrieve: ['*'],
      snippetEllipsisText: '...',
      responseFields: ['*'],
      facets: ['*'],
    })
    if (searchOption.rawAlgolia) {
      return search
    }
    const data: any[] = []
    const tasks = search.hits.map((hit) => {
      const { type, objectID } = hit

      const model = this.databaseService.getModelByRefType(type as 'post')
      if (!model) {
        return Promise.resolve()
      }
      return model
        .findById(objectID.split('_')[0])
        .select('_id title created modified categoryId slug nid')
        .lean({
          getters: true,
          autopopulate: true,
        })
        .then((doc) => {
          if (doc) {
            Reflect.set(doc, 'type', type)
            data.push(doc)
          }
        })
    })
    await Promise.all(tasks)
    return {
      data,
      raw: search,
      pagination: {
        currentPage: page,
        total: search.nbHits,
        hasNextPage: search.nbPages > search.page,
        hasPrevPage: search.page > 1,
        size: search.hitsPerPage,
        totalPage: search.nbPages,
      },
    }
  }

  /**
   * @description 每天凌晨推送一遍 Algolia Search
   */
  @CronOnce(CronExpression.EVERY_DAY_AT_MIDNIGHT, {
    name: 'pushToAlgoliaSearch',
  })
  @CronDescription('推送到 Algolia Search')
  @OnEvent(EventBusEvents.PushSearch)
  @OnEvent(BusinessEvents.POST_CREATE)
  @OnEvent(BusinessEvents.POST_UPDATE)
  @OnEvent(BusinessEvents.POST_DELETE)
  @OnEvent(BusinessEvents.NOTE_CREATE)
  @OnEvent(BusinessEvents.NOTE_UPDATE)
  @OnEvent(BusinessEvents.NOTE_DELETE)
  async pushAllToAlgoliaSearch() {
    const configs = await this.configs.waitForConfigReady()
    if (!configs.algoliaSearchOptions.enable || isDev) {
      return
    }
    const index = await this.getAlgoliaSearchIndex()

    this.logger.log('--> 开始推送到 Algolia')

    const documents = await this.buildAlgoliaIndexData()
    try {
      await Promise.all([
        index.replaceAllObjects(documents, {
          autoGenerateObjectIDIfNotExist: false,
        }),
        index.setSettings({
          attributesToHighlight: ['text', 'title'],
        }),
      ])

      this.logger.log('--> 推送到 algoliasearch 成功')
    } catch (error) {
      Logger.error('algolia 推送错误', 'AlgoliaSearch')
      throw error
    }
  }

  private canBeDecoded(textEncoded: Uint8Array): boolean {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(textEncoded)
      return true
    } catch {
      return false
    }
  }

  async buildAlgoliaIndexData() {
    const combineDocuments = await Promise.all([
      this.postService.model
        .find()
        .select('title text categoryId category slug')
        .populate('category', 'name slug')
        .lean()

        .then((list) => {
          return list.map((data) => {
            Reflect.set(data, 'objectID', data._id)
            Reflect.deleteProperty(data, '_id')
            return {
              ...data,
              text: removeMdCodeblock(data.text),
              type: 'post',
            }
          })
        }),
      this.pageService.model
        .find({}, 'title text slug subtitle')
        .lean()
        .then((list) => {
          return list.map((data) => {
            Reflect.set(data, 'objectID', data._id)
            Reflect.deleteProperty(data, '_id')
            return {
              ...data,
              type: 'page',
            }
          })
        }),
      this.noteService.model
        .find(
          {
            hide: false,
            $or: [
              { password: undefined },
              { password: null },
              { password: { $exists: false } },
            ],
          },
          'title text nid',
        )
        .lean()
        .then((list) => {
          return list.map((data) => {
            const id = data.nid.toString()
            Reflect.set(data, 'objectID', data._id)
            Reflect.deleteProperty(data, '_id')
            Reflect.deleteProperty(data, 'nid')
            return {
              ...data,
              type: 'note',
              id,
            }
          })
        }),
    ])

    const { algoliaSearchOptions } = await this.configs.waitForConfigReady()

    const combineDocumentsSplited: any[] = []
    combineDocuments.flat().forEach((item) => {
      const objectToAdjust = JSON.parse(JSON.stringify(item))
      objectToAdjust.text = objectToAdjust.text.replaceAll(
        /<style[^>]*>[\s\S]*?<\/style>/gi,
        '',
      )
      objectToAdjust.text = objectToAdjust.text.replaceAll(
        /<script[^>]*>[\s\S]*?<\/script>/gi,
        '',
      )
      const encodedSize = new TextEncoder().encode(
        JSON.stringify(objectToAdjust),
      ).length
      if (encodedSize <= algoliaSearchOptions.maxTruncateSize) {
        objectToAdjust.objectID = `${objectToAdjust.objectID}_0`
        combineDocumentsSplited.push(objectToAdjust)
      } else {
        const textEncoded = new TextEncoder().encode(objectToAdjust.text)
        const textSize = textEncoded.length
        const n = Math.ceil(
          textSize /
            (algoliaSearchOptions.maxTruncateSize - encodedSize + textSize),
        )
        let start = 0
        for (let i = 0; i < n; i++) {
          const newObject = JSON.parse(JSON.stringify(objectToAdjust))
          let end = start + Math.floor(textSize / n)
          while (!this.canBeDecoded(textEncoded.slice(start, end))) {
            end--
          }
          newObject.text = new TextDecoder('utf-8').decode(
            textEncoded.slice(start, end),
          )
          newObject.objectID = `${newObject.objectID}_${i}`
          combineDocumentsSplited.push(newObject)
          start = end
        }
      }
    })
    return combineDocumentsSplited
  }
}
