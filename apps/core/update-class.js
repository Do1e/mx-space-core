const { readFileSync, writeFileSync } = require('fs')
const assert = require('assert')
const { $ } = require('zx-cjs')
!(async () => {
  const classFiles = await $`find out/admin -name 'class-*.js'`
  const classFilePaths = classFiles.stdout.trim().split('\n')
  assert(classFilePaths.length === 1, 'Only one class file is expected')
  const filePath = classFilePaths[0]
  const fileContent = readFileSync(filePath, 'utf-8')
  const match = fileContent.match(
    /Error\("文章链接生成失败"\);([.|\s|\S]*?)message\.loading\("正在发布到 xLog\.\.\."\);/,
  )
  assert(match, 'Match failed')
  const xloginfo = match[1]
  //   const x=`${h}

  // <span style="text-align: right;font-size: 0.8em; float: right">此文由 [Mix Space](https://github.com/mx-space) 同步更新至 xLog
  // 原始链接为 <${v}></span><br ><br >`;

  const varx = xloginfo.match(/const (.*?)=/)[1]
  const varh = xloginfo.match(/=`\$\{(.*?)\}/)[1]
  const varv = xloginfo.match(/原始链接为 <\$\{(.*?)\}/)[1] //\$\{${varh}\}\
  const newXloginfo = `const ${varx} = \`<span style="text-align: right;font-size: 0.8em; float: right">此文由 [Mix Space](https://github.com/mx-space) 同步更新至 xLog
为获得最佳浏览体验，建议访问原始链接
<\$\{${varv}\}></span><br ><br >
\$\{${varh}\}\`;`
  const newFileContent = fileContent.replace(xloginfo, newXloginfo)
  writeFileSync(filePath, newFileContent)
})()
