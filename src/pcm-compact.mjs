export function joinPcm16(clips) {
  if(!clips.length)throw Error('没有音频片段');
  const rate=clips[0].buffer.readUInt32LE(24),channels=clips[0].buffer.readUInt16LE(22);
  const align=channels*2;const pieces=[];const manifest=[];
  let plannedPeak=0;
  for(const clip of clips){const gain=10**(Math.max(-3,Math.min(1,Number(clip.gainDb)||0))/20);for(let i=44;i<clip.buffer.length;i+=2)plannedPeak=Math.max(plannedPeak,Math.abs(clip.buffer.readInt16LE(i))*gain);}
  const attenuation=plannedPeak>30000?30000/plannedPeak:1;
  for(const [index,clip] of clips.entries()){
    const b=clip.buffer;
    if(b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,16)!=='WAVEfmt '||b.toString('ascii',36,40)!=='data'||b.readUInt16LE(20)!==1||b.readUInt16LE(34)!==16||b.readUInt32LE(24)!==rate||b.readUInt16LE(22)!==channels)throw Error('PCM 格式不一致');
    const count=(b.length-44)/align;let first=0,last=count;
    const window=Math.max(1,Math.round(rate*.01));const rms=[];
    for(let f=0;f<count;f+=window){let sum=0,n=0;for(let k=f;k<Math.min(count,f+window);k++)for(let ch=0;ch<channels;ch++){const v=b.readInt16LE(44+k*align+ch*2)/32768;sum+=v*v;n++;}rms.push(Math.sqrt(sum/n));}
    const peak=Math.max(...rms),threshold=Math.max(.002,peak*.025);
    const active=rms.map((r,i)=>r>=threshold?i:-1).filter(i=>i>=0);
    if(!active.length)throw Error('片段没有有效语音');
    const guard=Math.round(rate*.06);
    first=Math.max(0,active[0]*window-guard);last=Math.min(count,(active.at(-1)+1)*window+guard);
    const data=Buffer.from(b.subarray(44+first*align,44+last*align));
    const gain=10**(Math.max(-3,Math.min(1,Number(clip.gainDb)||0))/20)*attenuation;
    for(let k=0;k<data.length;k+=2){const value=b.readInt16LE(44+first*align+k)*gain;data.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(value))),k);}
    // 3 毫秒边缘淡入淡出，避免拼接处出现跳变。
    const fade=Math.min(Math.round(rate*.003),Math.floor((last-first)/2));
    for(let f=0;f<fade;f++)for(let ch=0;ch<channels;ch++){
      for(const offset of [f*align+ch*2,data.length-(f+1)*align+ch*2])data.writeInt16LE(Math.round(data.readInt16LE(offset)*f/fade),offset);
    }
    pieces.push(data);
    const pause=index===clips.length-1?0:Math.max(0,Math.min(500,clip.pauseAfterMs||0));
    pieces.push(Buffer.alloc(Math.round(rate*pause/1000)*align));
    manifest.push({text:clip.text,trimLeadingMs:first/rate*1000,trimTrailingMs:(count-last)/rate*1000,speechMs:(last-first)/rate*1000,pauseAfterMs:pause,gainDb:clip.gainDb||0});
  }
  let pcm=Buffer.concat(pieces);let peak=0;
  for(let i=0;i<pcm.length;i+=2)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i)));
  if(peak>30000)for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(Math.round(pcm.readInt16LE(i)*30000/peak),i);
  const header=Buffer.from(clips[0].buffer.subarray(0,44));header.writeUInt32LE(36+pcm.length,4);header.writeUInt32LE(pcm.length,40);
  return {buffer:Buffer.concat([header,pcm]),manifest};
}
