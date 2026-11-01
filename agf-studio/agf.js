(function (root) {
  'use strict';
  const MAX_RAW = 256 * 1024 * 1024;
  async function transform(bytes, compress) {
    const stream = new Blob([bytes]).stream().pipeThrough(compress ? new CompressionStream('deflate') : new DecompressionStream('deflate'));
    const reader = stream.getReader(), chunks = [];
    let length = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_RAW) throw new Error('압축 데이터가 허용 크기를 초과했습니다.');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }
  class AGF {
    static async read(input) {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      if (bytes.length < 2464) throw new Error('AGF 헤더가 너무 짧습니다.');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const file = new AGF();
      [file.version, file.width, file.height, file.count] = [0,4,8,12].map(p => view.getUint32(p, true));
      if (file.version !== 35 || file.count < 1 || file.count > 300 || !file.width || !file.height || file.width > 4096 || file.height > 4096) throw new Error('지원하지 않는 AGF 형식입니다. 현재 v35만 지원합니다.');
      file.payloadAt = 2416 + file.count * 8 + 48;
      if (bytes.length <= file.payloadAt || view.getUint32(file.payloadAt - 4, true) !== bytes.length - file.payloadAt) throw new Error('AGF 압축 크기가 일치하지 않습니다.');
      file.prefix = bytes.slice(0, file.payloadAt);
      file.offsets = Array.from({length:file.count}, (_,i) => view.getUint32(1216 + i*4, true));
      file.rects = Array.from({length:file.count}, (_,i) => [0,2,4,6].map(j => view.getUint16(2416+i*8+j, true)));
      file.raw = await transform(bytes.subarray(file.payloadAt), false);
      if (file.offsets[0] !== 0 || file.raw.length % 4) throw new Error('잘못된 프레임 데이터입니다.');
      for (let i=0;i<file.count;i++) {
        const [x,y,w,h] = file.rects[i], end = file.offsets[i+1] ?? file.raw.length;
        if (!w || !h || x+w > file.width || y+h > file.height || file.offsets[i]%4 || end > file.raw.length || end <= file.offsets[i]) throw new Error(`프레임 ${i}의 좌표 또는 오프셋이 잘못됐습니다.`);
        file.decode(i); // Validate every frame before accepting a file.
      }
      return file;
    }
    decode(index) {
      if (!Number.isInteger(index) || index < 0 || index >= this.count) throw new Error('프레임 번호 오류');
      const [x,y,w,h] = this.rects[index], end = this.offsets[index+1] ?? this.raw.length;
      const pixels = new Uint8ClampedArray(this.width*this.height*4);
      let cursor = 0;
      for (let p=this.offsets[index];p<end;p+=4) {
        const a = this.raw[p];
        if (a === 0) {
          const count = this.raw[p+1] | this.raw[p+2]<<8 | this.raw[p+3]<<16;
          if (!count) throw new Error(`프레임 ${index}: 길이가 0인 투명 구간`);
          cursor += count;
        } else {
          if (cursor >= w*h) throw new Error(`프레임 ${index}: 픽셀 범위 초과`);
          const dest = ((y+Math.floor(cursor/w))*this.width+x+cursor%w)*4;
          pixels[dest]=this.raw[p+1]; pixels[dest+1]=this.raw[p+2]; pixels[dest+2]=this.raw[p+3]; pixels[dest+3]=a;
          cursor++;
        }
        if (cursor > w*h) throw new Error(`프레임 ${index}: 투명 구간 범위 초과`);
      }
      if (cursor !== w*h) throw new Error(`프레임 ${index}: 픽셀 개수 불일치`);
      return pixels;
    }
    validateReplacement(index, pixels) {
      if (pixels.length !== this.width*this.height*4) throw new Error('PNG 캔버스 크기가 원본과 다릅니다.');
      const [rx,ry,rw,rh] = this.rects[index];
      for (let y=0;y<this.height;y++) for(let x=0;x<this.width;x++) {
        if (pixels[(y*this.width+x)*4+3] && (x<rx || x>=rx+rw || y<ry || y>=ry+rh)) throw new Error(`프레임 ${index}: 원본 저장 영역 밖에 불투명 픽셀이 있습니다. 자동 축소하거나 자르지 않습니다.`);
      }
    }
    async pack(replacements = new Map()) {
      for (const [index,pixels] of replacements) {
        if (!Number.isInteger(index) || index<0 || index>=this.count) throw new Error('교체 프레임 번호 오류');
        this.validateReplacement(index,pixels);
      }
      const prefix = this.prefix.slice(), view = new DataView(prefix.buffer), chunks=[];
      let offset=0;
      for (let i=0;i<this.count;i++) {
        view.setUint32(1216+i*4,offset,true);
        let chunk;
        if (!replacements.has(i)) chunk = this.raw.subarray(this.offsets[i],this.offsets[i+1] ?? this.raw.length);
        else {
          const pixels=replacements.get(i), [x,y,w,h]=this.rects[i];
          const encoded=new Uint8Array(w*h*4); let at=0;
          for (let row=0;row<h;row++) {
            let col=0;
            while(col<w) {
              const p=((y+row)*this.width+x+col)*4;
              if (pixels[p+3]) {
                encoded[at++]=pixels[p+3]; encoded[at++]=pixels[p]; encoded[at++]=pixels[p+1]; encoded[at++]=pixels[p+2]; col++;
              } else {
                const start=col;
                while(col<w && pixels[((y+row)*this.width+x+col)*4+3]===0) col++;
                const count=col-start;
                encoded[at++]=0; encoded[at++]=count&255; encoded[at++]=(count>>>8)&255; encoded[at++]=(count>>>16)&255;
              }
            }
          }
          chunk=encoded.subarray(0,at);
        }
        chunks.push(chunk); offset+=chunk.length;
      }
      if (offset>MAX_RAW) throw new Error('출력 데이터가 너무 큽니다.');
      const raw=new Uint8Array(offset); offset=0;
      for (const chunk of chunks) { raw.set(chunk,offset); offset+=chunk.length; }
      const compressed=await transform(raw,true);
      view.setUint32(this.payloadAt-4,compressed.length,true);
      const result=new Uint8Array(prefix.length+compressed.length); result.set(prefix); result.set(compressed,prefix.length);
      return result;
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports={AGF};
  root.AGF=AGF;
})(globalThis);
