import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { OwnedProcesses } from './processes.mjs'

test('cleanup kills a SIGTERM-ignoring descendant after its parent exits', async () => {
  const owned = new OwnedProcesses()
  const parent = owned.spawn(
    process.execPath,
    [
      '-e',
      `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
    child.stdout.once('data',()=>{process.stdout.write(String(child.pid)+'\\n');process.exit(0)});
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const exited = once(parent, 'exit')
  let output = ''
  parent.stdout.on('data', data => {
    output += data
  })
  try {
    await exited
    const descendant = Number(output.trim())
    assert.ok(descendant > 0)
    assert.doesNotThrow(() => process.kill(descendant, 0))
    await owned.stopAll(50)
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' })
  } finally {
    await owned.stopAll(50)
  }
})

test('interruption waits for owned descendants to disappear', async () => {
  const { spawn } = await import('node:child_process')
  const supervisor = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {OwnedProcesses} from ${JSON.stringify(
      new URL('./processes.mjs', import.meta.url).href,
    )};
    const owned=new OwnedProcesses();
    process.once('SIGTERM',async()=>{await owned.stopAll(50);process.exit(0)});
    const child=owned.spawn(process.execPath,['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
    child.stdout.once('data',()=>process.stdout.write(String(child.pid)));
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const exited = once(supervisor, 'exit')
  const [data] = await once(supervisor.stdout, 'data')
  const descendant = Number(data.toString())
  assert.ok(descendant > 0)
  supervisor.kill('SIGTERM')
  assert.deepEqual(await exited, [0, null])
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' })
})
