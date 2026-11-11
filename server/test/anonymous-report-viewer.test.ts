import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const code = await readFile(new URL('../examples/anonymous-report-viewer.js',import.meta.url),'utf8')
async function run(options: { hash?: string; query?: string; replaceError?: boolean; rows?: any[] } = {}) {
  const token = 'A'.repeat(43), calls: any[] = [], nodes: any[] = []
  const location = { hash: options.hash ?? `#${token}`, search: options.query ?? '', pathname:'/report-viewer' }
  const message = { textContent:'' }
  const list = { appendChild: (n: any) => nodes.push(n), replaceChildren: () => { nodes.length=0 } }
  const history = { replaceState: (_state: unknown,_title: string,path: string) => {
    if (options.replaceError) throw new Error('failed')
    assert.equal(path,'/report-viewer'); location.hash=''; location.search=''
    calls.push('clear')
  } }
  const document = { getElementById: (id: string) => id === 'message' ? message : list, createElement: () => ({textContent:''}) }
  const fetch = async (url: string, request: any) => {
    calls.push('fetch'); assert.equal(location.hash,''); assert.equal(url,'/api/v2/client-report/redeem'); assert.equal(request.credentials,'omit')
    assert.equal(request.referrerPolicy,'no-referrer'); assert.equal(request.redirect,'error'); assert.equal(request.cache,'no-store')
    assert.deepEqual(JSON.parse(request.body),{token})
    return {ok:true,json:async () => ({schema:'anonymous-report-v1',members:options.rows ?? [{label:'Member-'+'a'.repeat(32),status:'compliant',contact:'private'}], extra:'private'})}
  }
  await vm.runInNewContext(code,{location,history,document,fetch})
  return {calls,nodes,message,location}
}
test('viewer strips fragment before POST, omits credentials and projects text only',async () => {
  const r=await run()
  assert.deepEqual(r.calls,['clear','fetch']); assert.equal(r.nodes[0].textContent,'Member-'+'a'.repeat(32)+': compliant')
  assert.doesNotMatch(JSON.stringify(r),/private/)
})
test('viewer never sends invalid, query-bearing or uncleared capabilities',async () => {
  for (const options of [{hash:'#bad'}, {query:'?token=leak'}, {replaceError:true}]) {
    const r=await run(options)
    assert.ok(!r.calls.includes('fetch')); assert.equal(r.message.textContent,'This report is unavailable or has expired.')
  }
})
test('viewer refuses malicious nested fields as labels and status',async () => {
  const r=await run({rows:[{label:'<a href="https://bad.invalid">Contact</a>',status:'compliant'}]})
  assert.equal(r.nodes.length,0); assert.equal(r.message.textContent,'This report is unavailable or has expired.')
})
