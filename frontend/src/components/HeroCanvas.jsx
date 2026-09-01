import { useEffect, useRef } from 'react'

// Animated "molten" gradient banner background (ported from the BeOne Intelligence
// Suite reference). A WebGL fragment shader paints a flowing fbm-noise gradient;
// if WebGL is unavailable the parent's CSS gradient shows through.

const FRAG = `
precision highp float;
uniform float u_time; uniform vec2 u_res; uniform vec3 c1; uniform vec3 c2; uniform vec3 c3;
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p),f=fract(p); float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));
  vec2 u=f*f*(3.0-2.0*f); return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y; }
float fbm(vec2 p){ float v=0.0,a=0.55; mat2 m=mat2(1.7,1.25,-1.25,1.7);
  for(int i=0;i<6;i++){ v+=a*noise(p); p=m*p+0.07; a*=0.52; } return v; }
void main(){
  vec2 uv=gl_FragCoord.xy/u_res.xy;
  vec2 p=uv*1.9; p.x*=u_res.x/u_res.y;
  float t=u_time*0.11;
  vec2 q=vec2(fbm(p+vec2(0.0,t)), fbm(p+vec2(5.2,1.3)-t*0.7));
  vec2 r=vec2(fbm(p+4.0*q+vec2(1.7,9.2)+t*0.9),
              fbm(p+4.0*q+vec2(8.3,2.8)-t*0.6));
  float f=fbm(p+4.0*r);
  f=clamp((f-0.18)*1.85,0.0,1.0);
  float swirl=clamp(length(r)*0.95,0.0,1.0);
  vec3 col=mix(c1,c2,smoothstep(0.05,0.95,f));
  col=mix(col,c3,swirl);
  float crest=pow(clamp(f*(0.4+swirl),0.0,1.0),2.2);
  vec3 hot=clamp(c3*1.7+vec3(0.10,0.06,0.05),0.0,1.0);
  col=mix(col,hot,crest*0.85);
  col+=0.05*sin(t*3.0+uv.x*9.0+uv.y*4.0)*swirl;
  col*=0.80+0.26*(1.0-uv.y*0.85);
  gl_FragColor=vec4(col,1.0);
}`

// Palettes (deep -> mid -> accent), matching the reference shader palettes.
export const PALETTES = {
  landing: [[0.045, 0.1, 0.24], [0.8, 0.18, 0.15], [0.52, 0.13, 0.4]],
  weekly: [[0.045, 0.12, 0.26], [0.13, 0.42, 0.6], [0.36, 0.18, 0.64]],
  monitoring: [[0.13, 0.045, 0.075], [0.82, 0.24, 0.13], [0.74, 0.46, 0.1]],
}

export default function HeroCanvas({ palette = 'monitoring', className = 'mmhero__canvas' }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return undefined
    let gl
    try {
      gl = cv.getContext('webgl') || cv.getContext('experimental-webgl')
    } catch {
      gl = null
    }
    if (!gl) return undefined // CSS gradient fallback stays visible

    const vs = gl.createShader(gl.VERTEX_SHADER)
    gl.shaderSource(vs, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}')
    gl.compileShader(vs)
    const fs = gl.createShader(gl.FRAGMENT_SHADER)
    gl.shaderSource(fs, FRAG)
    gl.compileShader(fs)
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return undefined

    const pr = gl.createProgram()
    gl.attachShader(pr, vs)
    gl.attachShader(pr, fs)
    gl.linkProgram(pr)
    gl.useProgram(pr)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(pr, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    const uT = gl.getUniformLocation(pr, 'u_time')
    const uR = gl.getUniformLocation(pr, 'u_res')
    const c = PALETTES[palette] || PALETTES.monitoring
    gl.uniform3fv(gl.getUniformLocation(pr, 'c1'), c[0])
    gl.uniform3fv(gl.getUniformLocation(pr, 'c2'), c[1])
    gl.uniform3fv(gl.getUniformLocation(pr, 'c3'), c[2])

    let raf = 0
    const render = (ts) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.6)
      const w = cv.clientWidth * dpr
      const h = cv.clientHeight * dpr
      if (w && h && (cv.width !== w || cv.height !== h)) {
        cv.width = w
        cv.height = h
        gl.viewport(0, 0, w, h)
      }
      gl.uniform1f(uT, ts * 0.001)
      gl.uniform2f(uR, cv.width || 1, cv.height || 1)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      raf = requestAnimationFrame(render)
    }
    raf = requestAnimationFrame(render)

    // Only stop the animation loop on cleanup — do NOT lose the GL context. Under
    // React StrictMode the effect mounts twice on the SAME canvas; losing the
    // context here would leave the remount with a dead context and a blank canvas.
    return () => cancelAnimationFrame(raf)
  }, [palette])

  return <canvas className={className} ref={canvasRef} />
}
