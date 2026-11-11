// Composable only; no production mounting. All dependencies are trusted server-side implementations.
import express from 'express'
import type { Request, RequestHandler, Response } from 'express'
import type { V2AuthContext } from '../v2/auth.ts'
import { FILE_CONSENT_V1, FILE_CONSENT_V1_TEXT } from '../services/selfReportedPrivateFiles.ts'
import type { selfReportedPrivateFileService } from '../services/selfReportedPrivateFiles.ts'

type LimiterInput = { phase: 'preauth'|'principal'; remoteAddress: string; subject?: string }
type Options = {
  service: ReturnType<typeof selfReportedPrivateFileService>
  authenticate: RequestHandler
  // Must be a shared, atomic, server-owned limiter across all application instances;
  // this interface cannot establish those properties. A process-local mock is test-only.
  checkRateLimit: (input: LimiterInput) => Promise<boolean>
  maxFileBytes: number
  uploadDeadlineMs: number
}
const mimeTypes = new Set(['application/pdf','image/jpeg','image/png','image/webp'])
const exact = (v: unknown, keys: string[]) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k))
const failure = (res: Response, status=404) => res.status(status).json({error:'Unavailable'})
const pvalue = (res: Response): V2AuthContext | undefined => {
  const p = res.locals.authV2 as V2AuthContext | undefined
  return p && typeof p.subject === 'string' && p.subject.length > 0 && p.subject.length <= 256 && p.subject === p.subject.trim() && !/[\u0000-\u001f\u007f]/.test(p.subject) && (p.role === 'sub' || p.role === 'gc') && typeof p.credential === 'string' && p.credential.length > 0 && p.credential.length <= 8192 ? p : undefined
}
async function deadline<T>(f: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([Promise.resolve().then(f), new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error('deadline')),ms) })]) } finally { if (timer) clearTimeout(timer) }
}
function binary(req: Request, max: number, ms: number): Promise<Buffer> {
  return new Promise((resolve,reject) => {
    let size=0, done=false
    const chunks: Buffer[] = []
    const finish=(err?: Error) => {
      if (done) return
      done=true; clearTimeout(timer)
      req.removeListener('data',onData); req.removeListener('end',onEnd); req.removeListener('aborted',onAbort); req.removeListener('error',onAbort)
      if (err) { req.pause(); req.on('error',()=>{}); reject(err) } else resolve(Buffer.concat(chunks,size))
    }
    const onData=(chunk: Buffer) => { if (!Buffer.isBuffer(chunk)) return finish(new Error('invalid stream')); size+=chunk.length; if (size>max) return finish(new Error('limit')); chunks.push(chunk) }
    const onEnd=() => finish(size ? undefined : new Error('empty'))
    const onAbort=() => finish(new Error('aborted'))
    const timer=setTimeout(() => finish(new Error('deadline')),ms)
    if (req.readableEnded || req.destroyed || req.aborted) return finish(new Error('unavailable'))
    req.on('data',onData); req.once('end',onEnd); req.once('aborted',onAbort); req.once('error',onAbort)
  })
}
export function createSelfReportedPrivateFilesV2Router(options: Options): express.Router {
  if (!options?.service || typeof options.authenticate !== 'function' || typeof options.checkRateLimit !== 'function' || !Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1 || options.maxFileBytes > 10485760 || !Number.isSafeInteger(options.uploadDeadlineMs) || options.uploadDeadlineMs < 1 || options.uploadDeadlineMs > 60000) throw new Error('Service, verified auth, shared atomic limiter and bounded limits required')
  const router=express.Router({caseSensitive:true,strict:true})
  router.use((_req,res,next) => {res.set({'Cache-Control':'private, no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}); next()})
  const limit=(phase:'preauth'|'principal'): RequestHandler => (req,res,next) => {
    const remoteAddress=req.socket.remoteAddress, p=pvalue(res)
    if (!remoteAddress || (phase==='principal' && !p)) {failure(res,503); return}
    deadline(() => options.checkRateLimit({phase,remoteAddress,...(phase==='principal'?{subject:p!.subject}:{})}),2000).then(ok=>{if(ok===true) next(); else failure(res,429)},()=>failure(res,503))
  }
  router.use(limit('preauth'))
  router.use((req,res,next)=>{if(req.originalUrl.includes('?')) {failure(res); return} next()})
  router.use((req,res,next)=>{
    delete res.locals.authV2
    let done=false
    const verified=(err?: unknown) => {
      if(done) return; done=true
      if(res.headersSent || res.writableEnded || res.destroyed) return
      if(err || res.statusCode>=400 || !pvalue(res)) {failure(res,401); return}
      next()
    }
    try { Promise.resolve(options.authenticate(req,res,verified)).catch(verified) } catch { verified(new Error('authentication')) }
  })
  router.use(limit('principal'))
  const json=express.json({limit:'4kb',strict:true,type:'application/json'})
  const run=(role:'sub'|'gc'|'either',fn:(req:Request,p:V2AuthContext)=>Promise<unknown>):RequestHandler => (req,res)=>{
    const p=pvalue(res)!
    if(role!=='either' && p.role!==role) {failure(res); return}
    Promise.resolve().then(()=>fn(req,p)).then(v=>{if(res.destroyed || res.writableEnded) return; if(v===undefined) res.status(204).end(); else res.json(v)},()=>{if(!res.destroyed && !res.writableEnded) failure(res)})
  }
  router.get('/consent',run('either',async()=>({version:FILE_CONSENT_V1,text:FILE_CONSENT_V1_TEXT})))
  router.get('/own/list',run('sub',async(_req,p)=>options.service.listOwn(p.credential)))
  router.post('/own/list',json,run('sub',async(req,p)=>{if(!exact(req.body,['after'])) throw new Error(); return options.service.listOwn(p.credential,req.body.after)}))
  router.get('/granted/list',run('gc',async(_req,p)=>options.service.listGranted(p.credential)))
  router.post('/granted/list',json,run('gc',async(req,p)=>{if(!exact(req.body,['after'])) throw new Error(); return options.service.listGranted(p.credential,req.body.after)}))
  router.post('/grant',json,run('sub',async(req,p)=>{if(!exact(req.body,['fileId','gcUserId','consentVersion','affirmative'])) throw new Error(); await options.service.grant(p.credential,req.body.fileId,req.body.gcUserId,req.body.consentVersion,req.body.affirmative)}))
  router.post('/revoke',json,run('sub',async(req,p)=>{if(!exact(req.body,['fileId','gcUserId'])) throw new Error(); await options.service.revoke(p.credential,req.body.fileId,req.body.gcUserId)}))
  router.put('/own/:coiId',async(req,res)=>{
    const p=pvalue(res)!
    const deny=()=>{if(!res.destroyed && !res.writableEnded) {res.set('Connection','close'); failure(res)}}
    const mime=req.headers['content-type'], len=req.headers['content-length'], enc=req.headers['content-encoding']
    const count=(name:string)=>req.rawHeaders.filter((v,i)=>i%2===0 && v.toLowerCase()===name).length
    if(p.role!=='sub' || typeof mime!=='string' || !mimeTypes.has(mime) || count('content-type')!==1 || count('content-encoding')>1 || (enc!==undefined && enc!=='identity') || (len!==undefined && (!/^[1-9][0-9]*$/.test(len) || Number(len)>options.maxFileBytes))) {deny(); return}
    const controller=new AbortController(), deadlineAt=Date.now()+options.uploadDeadlineMs
    const timer=setTimeout(()=>controller.abort(),options.uploadDeadlineMs)
    const cancel=()=>controller.abort()
    const closed=()=>{if(!res.writableFinished) cancel()}
    req.once('aborted',cancel); res.once('close',closed)
    const stopped=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('deadline')),{once:true}))
    try {
      const data=await Promise.race([binary(req,options.maxFileBytes,options.uploadDeadlineMs),stopped])
      const result=await Promise.race([options.service.upload(p.credential,req.params.coiId,data,mime,{signal:controller.signal,deadlineAt}),stopped])
      if(!res.destroyed && !res.writableEnded) res.status(201).json(result)
    } catch {deny()} finally {clearTimeout(timer); req.removeListener('aborted',cancel); res.removeListener('close',closed)}
  })
  const download=(own:boolean):RequestHandler => (req,res)=>{
    const p=pvalue(res)!
    if(p.role!==(own?'sub':'gc')) {failure(res); return}
    const action=own ? options.service.downloadOwn(p.credential,req.params.fileId) : options.service.download(p.credential,req.params.fileId)
    action.then(result=>{if(res.destroyed || res.writableEnded) return; if(!result || !mimeTypes.has(result.mime) || !(result.bytes instanceof Uint8Array) || result.bytes.byteLength<1 || result.bytes.byteLength>options.maxFileBytes) {failure(res); return} res.set({'Content-Type':result.mime,'Content-Disposition':'attachment; filename="self-reported-file"','Content-Length':String(result.bytes.length),'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}); res.status(200).end(result.bytes)},()=>{if(!res.destroyed && !res.writableEnded) failure(res)})
  }
  router.get('/own/:fileId',download(true))
  router.get('/granted/:fileId',download(false))
  router.use((_err:unknown,_req:Request,res:Response,_next:express.NextFunction)=>{if(res.headersSent) res.destroy(); else failure(res,503)})
  router.use((_req,res)=>failure(res))
  return router
}
