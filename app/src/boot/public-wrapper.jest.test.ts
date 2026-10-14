/** @jest-environment jsdom */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineBoot } from '@quasar/app-vite'
import axios from 'axios'
import ts from 'typescript'
import { createApp } from 'vue'
import installAxios from './axios'

const appDir = resolve(__dirname, '../..')
const sourcePath = resolve(__dirname, 'axios.ts')
const config = ts.readConfigFile(
  resolve(appDir, 'tsconfig.json'),
  ts.sys.readFile,
)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, appDir)

function bootDiagnostics(invalidPlugin = false): readonly ts.Diagnostic[] {
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  host.readFile = file => {
    if (file !== sourcePath) return readFile(file)
    const source = readFileSync(file, 'utf8')
    return invalidPlugin
      ? source.replace(
          'app.config.globalProperties.$axios = axios',
          'app.use(123)',
        )
      : source
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options, host)
  const source = program.getSourceFile(sourcePath)
  if (!source) throw new Error('Axios boot source was not included')
  return program.getSemanticDiagnostics(source)
}

it('contextually types the production boot callback with the framework app contract', () => {
  expect(
    bootDiagnostics().map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ),
  ).toEqual([])
  expect(bootDiagnostics(true).map(diagnostic => diagnostic.code)).toEqual([
    2345,
  ])
})

it('executes the original callback and installs the production axios singleton', () => {
  const callback = () => undefined
  expect(defineBoot(callback)).toBe(callback)

  const app = createApp({})
  Reflect.apply(installAxios, undefined, [{ app }])
  expect(app.config.globalProperties.$axios).toBe(axios)
  expect(axios.defaults.headers.common['ngrok-skip-browser-warning']).toBe('1')
})
