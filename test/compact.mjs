import assert from 'node:assert/strict';
import {planCompact,compactSilence} from '../src/compact.mjs';
import {normalizeWav,createTts} from '../src/tts.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
assert.equal(planCompact('辛苦了',{mood:'温柔（2/3）'}).speed,1.08);
assert.equal(planCompact('你好',{mood:'得意（2/3）'}).strength,2);
assert.equal(planCompact('你好',{enabled:false,speed:1}).speed,1);
function wav(gap){const frames=16000+gap;const b=Buffer.alloc(44+frames*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*2,40);for(let i=0;i<frames;i++)if(i<8000||i>=8000+gap)b.writeInt16LE(3000,44+i*2);return b;}
const long=compactSilence(wav(6400));assert.equal(long.pauses.length,1);assert.equal(long.removedMs,260);assert.equal(normalizeWav(long.buffer).ms,1140);
assert.equal(compactSilence(wav(1600)).removedMs,0,'100ms 短停顿不变');
const original=wav(6400);assert.equal(compactSilence(original,{enabled:false}).buffer,original);
console.log('紧凑节奏测试通过：无叠加减速、情绪保留、长静音压缩、短停顿保留、关闭开关和 PCM 时长');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ff-compact-'));
try{
 const cfg={ttsEnabled:true,ttsEngine:'local',ttsEndpoint:'http://127.0.0.1:9883',ttsCompactEnabled:true};
 let calls=0;const tts=createTts({cfg,dir,fetchImpl:async()=>{calls++;return new Response(wav(6400));}});
 const compact=await tts.speak('测试',{mood:'温柔（2/3）'});
 assert.equal(compact.engine,'local');assert.equal(compact.ms,1140);
 assert.equal((await tts.speak('测试',{mood:'温柔（2/3）'})).file,compact.file);assert.equal(calls,1);
 cfg.ttsCompactEnabled=false;
 const normal=await tts.speak('测试',{mood:'温柔（2/3）'});
 assert.equal(normal.ms,1400);assert.notEqual(normal.file,compact.file);assert.equal(calls,2);
 console.log('TTS 集成通过：处理后实际时长、缓存复用、开关及缓存隔离');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
