import { Module } from '@nestjs/common'

import { AggregateModule } from '../aggregate/aggregate.module'
import { AiSummaryService } from '../ai/ai-summary/ai-summary.service'
import { AiModule } from '../ai/ai.module'
import { MarkdownModule } from '../markdown/markdown.module'
import { FeedController } from './feed.controller'

@Module({
  controllers: [FeedController],
  providers: [AiSummaryService],
  imports: [AggregateModule, MarkdownModule, AiModule],
})
export class FeedModule {}
