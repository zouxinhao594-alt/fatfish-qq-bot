import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTts, normalizeWav } from '../src/tts.mjs';
import { createCapabilities } from '../src/capabilities.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-tests-'));
function wav(seconds = 1) {
  const b = Buffer.alloc(44 + seconds * 48000);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(b.length - 44, 40); return b;
}
let passed = 0;
async function test(name, fn) { await fn(); console.log('ok', name); passed++; }
const ref = path.join(dir, 'ref.wav'); fs.writeFileSync(ref, wav());
const cfg = { ttsEnabled: true, ttsEngine: 'local', ttsEndpoint: 'http://127.0.0.1:9880',
  ttsRefAudio: ref, ttsRefText: '你好', ttsMaxSeconds: 1, ttsPerMinute: 2 };
let calls = 0, sapiCalls = 0, body;
const fetchImpl = async (url, opts) => {
  calls++; body = JSON.parse(opts.body);
  assert.equal(url, 'http://127.0.0.1:9880/tts');
  return new Response(wav(2));
};
const sapiImpl = async ({ file }) => { sapiCalls++; fs.writeFileSync(file, wav()); };
const tts = createTts({ cfg, dir: path.join(dir, 'tts'), fetchImpl, sapiImpl });
try {
  await test('PCM 校验与实际时长截断', () => {
    assert.equal(normalizeWav(wav(2), 1).ms, 1000);
    assert.throws(() => normalizeWav(Buffer.from('{"error":"bad"}')));
    assert.throws(() => normalizeWav(wav().subarray(0, 100)));
  });
  await test('本地接口参数、返回契约及并发缓存去重', async () => {
    const [a,b] = await Promise.all([tts.speak('你好'), tts.speak('你好')]);
    assert.deepEqual(a,b); assert.equal(calls,1); assert.equal(a.engine,'local');
    assert.equal(a.ms,1000); assert.equal(body.streaming_mode,false);
    assert.equal(body.ref_audio_path,ref); assert.equal(body.prompt_lang,'zh');
    await tts.speak('你好'); assert.equal(calls,1);
  });
  await test('参考文本与文件内容变化使缓存失效', async () => {
    cfg.ttsRefText='换一句'; await tts.speak('你好'); assert.equal(calls,2);
    const b=wav(); b[44]=1; fs.writeFileSync(ref,b);
    await tts.speak('你好'); assert.equal(calls,3);
  });
  await test('坏响应降级 SAPI，恢复后重新请求本地引擎', async () => {
    let broken=true;
    const t=createTts({cfg, dir:path.join(dir,'fallback'), sapiImpl,
      fetchImpl:async()=>broken ? new Response('{}') : new Response(wav())});
    assert.equal((await t.speak('恢复')).engine,'sapi');
    broken=false; assert.equal((await t.speak('恢复')).engine,'local');
    assert.equal(sapiCalls,1);
  });
  await test('两个引擎都失败抛错；空文本不合成', async () => {
    const t=createTts({cfg,dir:path.join(dir,'fail'),fetchImpl:async()=>{throw Error('down');},
      sapiImpl:async()=>{throw Error('down');}});
    await assert.rejects(t.speak('你好')); await assert.rejects(t.speak('  '));
  });
  await test('字数截断及关闭缓存', async () => {
    const c={...cfg,ttsMaxChars:2,ttsCacheEnabled:false};
    const t=createTts({cfg:c,dir:path.join(dir,'nocache'),fetchImpl,sapiImpl});
    const a=await t.speak('你好呀'); const b=await t.speak('你好呀');
    assert.equal(body.text,'你好'); assert.notEqual(a.file,b.file);
  });
  await test('并发每群限流、跨群隔离及 base64 段', async () => {
    const caps=createCapabilities({cfg:{...cfg,outboundImageMaxKB:0.001},dataDir:path.join(dir,'caps'),
      llm:{},fetchImpl});
    const reply={voice:true,segments:['你好']};
    const results=await Promise.all(Array.from({length:3},()=>caps.act(reply,{groupId:'1'})));
    assert.equal(results.filter(r=>r.length).length,2);
    assert.equal(results[0][0][0].type,'record');
    assert.ok(results[0][0][0].data.file.startsWith('base64://'));
    assert.equal((await caps.act(reply,{groupId:'2'})).length,1);
  });
  await test('关闭缓存和保留文件后，出站编码完成即清理', async () => {
    const caps=createCapabilities({cfg:{...cfg,ttsCacheEnabled:false,ttsKeepFiles:false},
      dataDir:path.join(dir,'cleanup'),llm:{},fetchImpl});
    assert.equal((await caps.act({voice:true,segments:['你好']},{groupId:'1'})).length,1);
    assert.equal(fs.readdirSync(caps.dirs.ttsDir).length,0);
  });
  await test('不同心情分开缓存，同一心情命中缓存', async () => {
    let count=0, seen=[];
    const t=createTts({cfg:{...cfg,ttsEmotionEnabled:true},dir:path.join(dir,'emotions'),sapiImpl,
      fetchImpl:async (_url,opts)=>{count++;seen.push(JSON.parse(opts.body));return new Response(wav());}});
    const happy=await t.speak('我陪着你',{mood:'得意'});
    const sleepy=await t.speak('我陪着你',{mood:'困（2/3）'});
    const again=await t.speak('我陪着你',{mood:'得意'});
    assert.equal(count,2);assert.notEqual(happy.file,sleepy.file);assert.equal(happy.file,again.file);
    assert.deepEqual(seen.map(x=>x.emotion),['得意','困']);
  });
  await test('关闭情绪时不同心情复用自然语气缓存', async () => {
    let count=0;
    const t=createTts({cfg:{...cfg,ttsEmotionEnabled:false},dir:path.join(dir,'no-emotion'),sapiImpl,
      fetchImpl:async (_url,opts)=>{count++;assert.equal(JSON.parse(opts.body).emotion,'');return new Response(wav());}});
    await t.speak('你好',{mood:'得意'});await t.speak('你好',{mood:'困'});assert.equal(count,1);
  });
  await test('无参考素材的本地服务不依赖旧音频', async () => {
    const t=createTts({cfg:{...cfg,ttsRefAudio:''},dir:path.join(dir,'no-reference'),sapiImpl,fetchImpl});
    assert.equal((await t.speak('你好')).engine,'local');
    assert.equal(body.ref_audio_path,'');
  });
  await test('能力层优先回复心情，否则使用当前心情', async () => {
    const seen=[];
    const caps=createCapabilities({cfg,dataDir:path.join(dir,'mood-act'),llm:{},
      fetchImpl:async(_url,opts)=>{seen.push(JSON.parse(opts.body).emotion);return new Response(wav());}});
    await caps.act({voice:true,segments:['你好'],mood:'委屈'},{groupId:'1'},{mood:'困'});
    await caps.act({voice:true,segments:['再见']},{groupId:'2'},{mood:'困（2/3）'});
    assert.deepEqual(seen,['委屈','困']);
  });
  console.log(`${passed}/${passed} 语音专项通过`);
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
