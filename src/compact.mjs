import {planProsody} from './prosody.mjs';
// 一次合成完整话语，避免短句独立合成反复起腔和额外停顿。
export function planCompact(text,{mood='',speed=1,enabled=true}={}) {
  const plan=planProsody({text,mood,speed,enabled});
  if(!enabled)return plan;
  const pace={温柔:1.08,开心:1.10,得意:1.10,困:.98,认真:1.04}[plan.emotion]||1.04;
  const variation=plan.strength ? (plan.strength-2)*.015 : 0;
  plan.speed=Math.max(.5,Math.min(2,(Number(speed)||1)*(pace+variation)));
  plan.pauseMs=110;
  return plan;
}

// 只压缩至少 250ms 的极低能量内部停顿，保留正常短停顿与辅音。
export function compactSilence(buffer,{enabled=true,minMs=250,keepMs=140}={}) {
  if(!enabled)return {buffer,removedMs:0,pauses:[]};
  if(buffer.toString('ascii',8,16)!=='WAVEfmt '||buffer.toString('ascii',36,40)!=='data'||buffer.readUInt16LE(20)!==1||buffer.readUInt16LE(34)!==16)throw Error('需要规范 PCM16 WAV');
  const rate=buffer.readUInt32LE(24),align=buffer.readUInt16LE(22)*2,frames=(buffer.length-44)/align;
  const step=Math.max(1,Math.round(rate*.01)),quiet=[];
  for(let f=0;f<frames;f+=step){let sum=0,n=0,peak=0;for(let k=f*align;k<Math.min(frames,f+step)*align;k+=2){const v=buffer.readInt16LE(44+k)/32768;sum+=v*v;peak=Math.max(peak,Math.abs(v));n++;}quiet.push(Math.sqrt(sum/n)<.001&&peak<.004);}
  const removals=[];let start=-1;
  for(let i=0;i<=quiet.length;i++){
    if(quiet[i]===true){if(start<0)start=i;continue;}
    if(start>=0){
      const length=(i-start)*step;
      if(start>0&&i<quiet.length&&length/rate*1000>=minMs){
        const keep=Math.round(rate*keepMs/1000),cut=length-keep;
        if(cut>0)removals.push({from:start*step+Math.floor(keep/2),to:i*step-Math.ceil(keep/2),originalMs:length/rate*1000});
      }
      start=-1;
    }
  }
  const chunks=[];let cursor=0;
  for(const r of removals){chunks.push(buffer.subarray(44+cursor*align,44+r.from*align));cursor=r.to;}
  chunks.push(buffer.subarray(44+cursor*align));
  const pcm=Buffer.concat(chunks),header=Buffer.from(buffer.subarray(0,44));header.writeUInt32LE(36+pcm.length,4);header.writeUInt32LE(pcm.length,40);
  return {buffer:Buffer.concat([header,pcm]),removedMs:(buffer.length-44-pcm.length)/align/rate*1000,pauses:removals};
}
