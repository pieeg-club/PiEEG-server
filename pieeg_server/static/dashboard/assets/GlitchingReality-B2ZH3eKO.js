import{u as le,r as i,F as oe,a as B,j as t}from"./index-7aFliHxP.js";const ce=256,ue=80,D=.22,he=.006,de=.12,me=.35,fe=Object.fromEntries(B.map(n=>[n.name,0])),ae={faa:0,calm:.5,betaSurge:0,instability:0,snapping:!1,bands:fe,activeChannels:0};function ve(n){const r=le(),l=i.useRef(null);(!l.current||l.current.sampleRateHz!==r)&&(l.current=new oe(ce,r));const c=i.useRef(ae),[x,u]=i.useState(ae);return i.useEffect(()=>{const h=l.current;let A=0,o=0,_=0,f=0,b=0;const y=Object.fromEntries(B.map(C=>[C.name,0]));let m=.5,v=0,j=0,T=0,M=0;const H=setInterval(()=>{const{buffers:C,writeIndex:z,samplesInBuffer:N,numChannels:S}=n;if(S<1)return;const g=z.current,K=N.current,P=Object.fromEntries(B.map(p=>[p.name,0]));let I=0,q=0,w=0;for(let p=0;p<S;p++){const L=C.current[p];if(!L)continue;const $=h.analyseRing(L,g,K);if($){for(const W of B)P[W.name]+=$.bandPowers[W.name]??0;I++,p===0&&(q=$.bandPowers.Alpha??0),p===1&&(w=$.bandPowers.Alpha??0)}}if(I===0)return;for(const p of B){const L=P[p.name]/I;y[p.name]+=D*(L-y[p.name])}const Q=P.Alpha/I,O=P.Beta/I;A+=D*(Q-A),o+=D*(O-o),_+=D*(q-_),f+=D*(w-f),b+=he*(o-b);const a=b>1e-9?Math.max(0,Math.min(1,(o-b)/(b+1e-9))):0,s=S>=2?Math.log(Math.max(f,1e-9))-Math.log(Math.max(_,1e-9)):0,e=A+o,d=e>1e-9?A/e:.5;m+=de*(d-m);const R=1-m+.6*a-.15*Math.max(0,s),E=Math.max(0,Math.min(1,R));T>1e-9&&(T-o)/T>me&&(j=performance.now()+600,M=6),T=o;const X=performance.now()<j;let V=E>v?.18:.08;M>0&&(V=.55,M--),v+=V*(E-v),X&&(v*=.85),v=Math.max(0,Math.min(1,v)),c.current={faa:s,calm:m,betaSurge:a,instability:v,snapping:X,bands:{...y},activeChannels:I}},ue),F=setInterval(()=>u({...c.current}),200);return()=>{clearInterval(H),clearInterval(F)}},[n]),{liveRef:c,snapshot:x}}const ge=`#version 300 es
out vec2 v_uv;
void main() {
  // Fullscreen triangle from gl_VertexID (no VBO needed).
  vec2 p = vec2(
    (gl_VertexID == 1) ?  3.0 : -1.0,
    (gl_VertexID == 2) ?  3.0 : -1.0
  );
  v_uv = (p + 1.0) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`,pe=`#version 300 es
precision highp float;

in  vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_tex;
uniform float u_time;
uniform float u_instability;
uniform float u_snap;
uniform float u_faa;
uniform vec2  u_resolution;
uniform float u_videoAspect;

// ── hash / noise ────────────────────────────────────────────────────
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float hash11(float x) { return fract(sin(x * 91.3458) * 47453.5453); }

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

// Map the [0,1] screen uv to a cover-fit uv into the video texture.
vec2 coverUV(vec2 uv) {
  float canvasAR = u_resolution.x / max(u_resolution.y, 1.0);
  float vAR = max(u_videoAspect, 0.01);
  vec2 scale = vec2(1.0);
  if (canvasAR > vAR) {
    // Canvas wider than video → crop vertically.
    scale.y = vAR / canvasAR;
  } else {
    scale.x = canvasAR / vAR;
  }
  vec2 centered = (uv - 0.5) / scale + 0.5;
  return centered;
}

void main() {
  float inst = clamp(u_instability, 0.0, 1.0);
  // Soft "reality is breaking" curve — quiet at low values, blooms near 1.
  float bend = pow(inst, 1.6);

  vec2 uv = v_uv;

  // ── 1. Slice tear (horizontal datamosh) ─────────────────────────
  float bandY = floor(uv.y * (12.0 + 60.0 * bend));
  float bandSeed = hash11(bandY + floor(u_time * 6.0));
  float doTear = step(0.78 - 0.45 * bend, bandSeed);
  float tearAmount = (bandSeed - 0.5) * 0.18 * bend * doTear;
  uv.x += tearAmount;

  // Block displacement — coarser glitch blocks at high inst.
  float blocks = 18.0 + 40.0 * bend;
  vec2 blockId = floor(uv * blocks);
  float blockJitter = hash(blockId + floor(u_time * 8.0));
  if (blockJitter > 1.0 - 0.35 * bend) {
    uv.x += (blockJitter - 0.5) * 0.08 * bend;
    uv.y += (hash(blockId + 17.0) - 0.5) * 0.04 * bend;
  }

  // Scanline ripple — ever-present at very low amplitude.
  uv.x += sin(uv.y * (200.0 + 600.0 * bend) + u_time * 4.0)
        * (0.0008 + 0.012 * bend);

  // ── 2. Chromatic aberration / RGB split ─────────────────────────
  // FAA biases the split direction — left hemi dominance pushes red
  // leftward, right hemi pushes it rightward.  Subtle when calm.
  float faaBias = clamp(u_faa * 0.5, -1.0, 1.0);
  float ca = (0.002 + 0.025 * bend) * (1.0 + abs(faaBias) * 0.6);
  vec2 dirR = vec2( ca * (1.0 + faaBias * 0.4),  ca * 0.2 * bend);
  vec2 dirB = vec2(-ca * (1.0 - faaBias * 0.4), -ca * 0.2 * bend);

  vec2 uvR = coverUV(uv + dirR);
  vec2 uvG = coverUV(uv);
  vec2 uvB = coverUV(uv + dirB);

  vec3 col;
  col.r = texture(u_tex, uvR).r;
  col.g = texture(u_tex, uvG).g;
  col.b = texture(u_tex, uvB).b;

  // ── 3. Scanlines + brightness pulse ─────────────────────────────
  float scan = 0.5 + 0.5 * sin(v_uv.y * u_resolution.y * 1.2);
  col *= mix(1.0, 0.85 + 0.15 * scan, 0.15 + 0.55 * bend);

  float pulse = sin(u_time * (3.0 + 9.0 * bend)) * 0.5 + 0.5;
  col *= 1.0 + (pulse - 0.5) * 0.35 * bend;

  // ── 4. Snow / hash noise ────────────────────────────────────────
  float n = noise(v_uv * (350.0 + 800.0 * bend) + u_time * 30.0);
  col = mix(col, vec3(n), 0.05 + 0.35 * bend);

  // ── 5. Harsh light — contrast + saturation crush ────────────────
  float harsh = 0.4 * bend;
  col = (col - 0.5) * (1.0 + harsh * 2.0) + 0.5;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, 1.0 - harsh * 0.5);
  col = clamp(col, 0.0, 1.0);

  // ── 6. Mood tint — cyan when calm, rose/amber when fractured ───
  vec3 calmTint    = vec3(0.85, 1.05, 1.15);
  vec3 fracTint    = vec3(1.20, 0.85, 0.95);
  float tintMix    = smoothstep(0.2, 0.85, bend);
  vec3 tint = mix(calmTint, fracTint, tintMix);
  col *= tint;

  // ── 7. Vignette: gentle dim at low inst, hot bloom at high ─────
  vec2 q = v_uv - 0.5;
  float vig = 1.0 - dot(q, q) * (0.9 + 1.6 * bend);
  vig = clamp(vig, 0.0, 1.0);
  col *= mix(0.95, vig, 0.55);
  // Edge "hot" bleed at high instability.
  float edge = 1.0 - vig;
  col += vec3(0.95, 0.20, 0.45) * edge * bend * 0.55;

  // ── 8. Snap → clarity flash ─────────────────────────────────────
  if (u_snap > 0.5) {
    float ring = exp(-length(q) * 6.0) * 0.85;
    col += vec3(0.55, 0.95, 1.0) * ring;
    col = pow(col, vec3(0.85));   // brief clarity gamma lift
  }

  // ── 9. Mild base grain — keeps "MR camera" feel even when calm ─
  float baseGrain = (noise(v_uv * 900.0 + u_time * 60.0) - 0.5) * 0.025;
  col += baseGrain;

  fragColor = vec4(col, 1.0);
}
`;function xe({integrity:n,stateKey:r}){const o=m=>m*Math.PI/180,_=(m,v,j)=>{const T={x:70+m*Math.cos(o(v)),y:70+m*Math.sin(o(v))},M={x:70+m*Math.cos(o(j)),y:70+m*Math.sin(o(j))},G=Math.abs(j-v)>180?1:0;return`M ${T.x} ${T.y} A ${m} ${m} 0 ${G} 1 ${M.x} ${M.y}`},f=Math.max(0,Math.min(1,n)),b=-210+240*f,y=r==="calm"?"#5cf2ff":r==="drift"?"#c4f0ff":r==="tear"?"#ffb347":"#ff3366";return t.jsxs("svg",{className:"gl-gauge-svg",viewBox:"0 0 140 140","aria-hidden":"true",children:[t.jsx("path",{d:_(52,-210,30),className:"gl-gauge-track"}),f>0&&t.jsx("path",{d:_(52,-210,b),className:"gl-gauge-fill",style:{stroke:y,filter:`drop-shadow(0 0 6px ${y})`}}),t.jsx("text",{x:70,y:64,className:"gl-gauge-pct",style:{fill:y},children:Math.round(f*100)}),t.jsx("text",{x:70,y:84,className:"gl-gauge-unit",children:"%"})]})}function J(n){const r=u=>Math.floor(Math.random()*u);if(n<=1){const u=12+r(40),h=8+r(30);return{q:`${u} + ${h}`,a:u+h}}if(n<=2){const u=30+r(80),h=10+r(60);return{q:`${u} − ${h}`,a:u-h}}if(n<=3){const u=6+r(13),h=4+r(13);return{q:`${u} × ${h}`,a:u*h}}if(n<=4){const u=7+r(11),h=3+r(8),A=5+r(20);return{q:`${u} × ${h} − ${A}`,a:u*h-A}}const l=13+r(40),c=4+r(8),x=3+r(11);return{q:`${l} × ${c} + ${l} − ${x}`,a:l*c+l-x}}function ne(n,r,l){const c=n.createShader(r);if(n.shaderSource(c,l),n.compileShader(c),!n.getShaderParameter(c,n.COMPILE_STATUS)){const x=n.getShaderInfoLog(c);throw n.deleteShader(c),new Error(`Shader compile failed: ${x}`)}return c}function be(n){const r=ne(n,n.VERTEX_SHADER,ge),l=ne(n,n.FRAGMENT_SHADER,pe),c=n.createProgram();if(n.attachShader(c,r),n.attachShader(c,l),n.linkProgram(c),!n.getProgramParameter(c,n.LINK_STATUS)){const x=n.getProgramInfoLog(c);throw new Error(`Program link failed: ${x}`)}return c}const se={calm:["Keep it up — eyes soft, jaw loose.","Feel your exhale lengthen.","Let thoughts pass without engaging them."],drift:["Slow down your breathing — 4 s in, 6 s out.","Drop your shoulders. Relax your eyes.","Observe the distortion without reacting to it."],tear:["Take one slow, deep belly breath now.","Close your eyes for 2 seconds, then re-open.","Unclench your jaw and forehead."],frac:["Stop the puzzle. Breathe first.","Long exhale — let beta fall.","Eyes closed, 3 slow breaths."]};function ye({eegData:n,onExit:r}){const[l,c]=i.useState("intro"),[x,u]=i.useState(null),[h,A]=i.useState(!1),[o,_]=i.useState(3),[f,b]=i.useState(null),[y,m]=i.useState(""),[v,j]=i.useState(!1),[T,M]=i.useState(0),[G,H]=i.useState(0),F=i.useRef(null),C=i.useRef(null),z=i.useRef(null),N=i.useRef(null),{liveRef:S,snapshot:g}=ve(n),K=i.useCallback(async()=>{u(null);try{const a=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}},audio:!1});z.current=a;const s=F.current;s&&(s.srcObject=a,s.muted=!0,s.playsInline=!0,await s.play()),c("live")}catch(a){const s=a instanceof Error?a.message:String(a);u(`Camera access denied — ${s}`)}},[]);i.useEffect(()=>()=>{var a;(a=z.current)==null||a.getTracks().forEach(s=>s.stop()),z.current=null,N.current!=null&&cancelAnimationFrame(N.current)},[]),i.useEffect(()=>{if(l!=="live")return;const a=C.current,s=F.current;if(!a||!s)return;const e=a.getContext("webgl2",{antialias:!1,alpha:!1});if(!e){u("WebGL2 not available on this device.");return}let d;try{d=be(e)}catch(k){u(k.message);return}const R=e.createVertexArray();e.bindVertexArray(R);const E=e.createTexture();e.bindTexture(e.TEXTURE_2D,E),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR);const U=e.getUniformLocation(d,"u_tex"),X=e.getUniformLocation(d,"u_time"),V=e.getUniformLocation(d,"u_instability"),p=e.getUniformLocation(d,"u_snap"),L=e.getUniformLocation(d,"u_resolution"),$=e.getUniformLocation(d,"u_videoAspect"),W=e.getUniformLocation(d,"u_faa");let Z=!1;const re=performance.now(),ie=()=>{const k=Math.min(window.devicePixelRatio||1,2),Y=Math.floor(a.clientWidth*k),te=Math.floor(a.clientHeight*k);(a.width!==Y||a.height!==te)&&(a.width=Y,a.height=te),e.viewport(0,0,a.width,a.height)},ee=()=>{if(Z)return;ie(),e.useProgram(d),s.readyState>=2&&s.videoWidth>0&&(e.bindTexture(e.TEXTURE_2D,E),e.pixelStorei(e.UNPACK_FLIP_Y_WEBGL,!0),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,s));const k=S.current;e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,E),e.uniform1i(U,0),e.uniform1f(X,(performance.now()-re)/1e3),e.uniform1f(V,k.instability),e.uniform1f(p,k.snapping?1:0),e.uniform1f(W,Math.max(-2,Math.min(2,k.faa))),e.uniform2f(L,a.width,a.height);const Y=s.videoWidth>0?s.videoWidth/s.videoHeight:16/9;e.uniform1f($,Y),e.drawArrays(e.TRIANGLES,0,3),N.current=requestAnimationFrame(ee)};return N.current=requestAnimationFrame(ee),()=>{Z=!0,N.current!=null&&cancelAnimationFrame(N.current),e.deleteProgram(d),e.deleteTexture(E),e.deleteVertexArray(R)}},[l,S]),i.useEffect(()=>{if(l!=="live")return;const a=setInterval(()=>{M(s=>{const e=S.current.instability,d=e>.75?-2:e>.5?-.5:e<.25?1:0;return Math.max(0,s+d)})},1e3);return()=>clearInterval(a)},[l,S]),i.useEffect(()=>{if(l!=="live")return;const a=setInterval(()=>{H(s=>(s+1)%3)},8e3);return()=>clearInterval(a)},[l]),i.useEffect(()=>{if(!h){b(null),m("");return}(()=>{const{q:e,a:d}=J(o);b(R=>({question:e,answer:d,deadline:performance.now()+Math.max(4e3,11e3-o*1500),streak:(R==null?void 0:R.streak)??0,lastResult:null})),m("")})();const s=setInterval(()=>{b(e=>{if(!e)return e;if(performance.now()>e.deadline){const{q:d,a:R}=J(o);return{question:d,answer:R,deadline:performance.now()+Math.max(4e3,11e3-o*1500),streak:0,lastResult:"wrong"}}return e})},200);return()=>clearInterval(s)},[h,o]);const P=i.useCallback(()=>{b(a=>{if(!a)return a;const s=parseInt(y,10),e=!isNaN(s)&&s===a.answer,{q:d,a:R}=J(o),E=e?a.streak+1:0;return e&&E>0&&E%3===0&&o<5?_(U=>Math.min(5,U+1)):!e&&o>1&&_(U=>Math.max(1,U-1)),{question:d,answer:R,deadline:performance.now()+Math.max(4e3,11e3-o*1500),streak:E,lastResult:e?"correct":"wrong"}}),m("")},[y,o]),I=i.useMemo(()=>Math.max(0,1-g.instability),[g.instability]),q=g.snapping?"SNAP → CLARITY":g.instability>.75?"REALITY FRACTURED":g.instability>.5?"TEARING":g.instability>.25?"DRIFTING":"EQUANIMITY",w=g.instability>.75?"frac":g.instability>.5?"tear":g.instability>.25?"drift":"calm",Q=se[w][G%se[w].length],O=f?Math.max(0,f.deadline-performance.now())/1e3:0;return t.jsxs("div",{className:"glitch-root",children:[t.jsx("video",{ref:F,className:"glitch-video",autoPlay:!0,playsInline:!0,muted:!0,"aria-hidden":"true"}),t.jsx("canvas",{ref:C,className:`glitch-canvas ${l==="live"?"is-live":""}`}),l==="intro"&&t.jsxs("div",{className:"glitch-panel glitch-intro",children:[t.jsx("button",{className:"glitch-exit",onClick:r,children:"✕ Exit"}),t.jsx("h1",{children:"The Glitching Reality"}),t.jsx("p",{className:"glitch-tag",children:"I wired my brain to my room.  If I lose focus, reality breaks."}),t.jsxs("p",{className:"glitch-prose",children:["This is a purely visual demonstration of ",t.jsx("strong",{children:"Frontal Alpha Asymmetry"}),".  Your phone or headset camera becomes a mixed- reality passthrough; a real-time shader composites EEG-driven distortion on top."]}),t.jsxs("ul",{className:"glitch-list",children:[t.jsxs("li",{children:[t.jsx("span",{children:"•"})," When you are calm and equanimous, the room is pristine."]}),t.jsxs("li",{children:[t.jsx("span",{children:"•"})," Cognitive load tears the scene apart — RGB split, slice tear, harsh light."]}),t.jsxs("li",{children:[t.jsx("span",{children:"•"})," A deep, slow breath snaps reality back to clarity."]})]}),t.jsx("p",{className:"glitch-prose glitch-dim",children:"Works with any electrode placement and any number of channels. When two or more channels are connected, Frontal Alpha Asymmetry is computed from channels 1 & 2; with a single channel the calm / β signal still drives the shader. Best in a darkened room, on a phone or Quest Browser."}),x&&t.jsx("div",{className:"glitch-err",children:x}),t.jsxs("div",{className:"glitch-actions",children:[t.jsx("button",{className:"glitch-btn glitch-btn--primary",onClick:K,children:"Wire In"}),t.jsx("button",{className:"glitch-btn",onClick:r,children:"Cancel"})]})]}),l==="live"&&t.jsxs(t.Fragment,{children:[t.jsx("button",{className:"glitch-exit glitch-exit--floating",onClick:r,children:"✕ Exit"}),t.jsxs("div",{className:"gl-panel gl-panel--tl",children:[t.jsx("div",{className:"gl-panel-label",children:"REALITY INTEGRITY"}),t.jsx(xe,{integrity:I,stateKey:w}),t.jsx("div",{className:`gl-state-label lvl-${g.snapping?"snap":w}`,children:q}),t.jsxs("div",{className:"gl-score-row",children:[t.jsx("span",{className:"gl-score-k",children:"SCORE"}),t.jsx("span",{className:"gl-score-v",children:Math.floor(T)})]})]}),t.jsxs("div",{className:"gl-panel gl-panel--tr",children:[t.jsx("button",{className:"gl-info-btn",onClick:()=>j(a=>!a),"aria-expanded":v,children:v?"▲ hide":"? guide"}),v&&t.jsxs("div",{className:"gl-guide",children:[t.jsxs("p",{children:[t.jsx("strong",{children:"Keep reality stable"})," — stay calm to score points."]}),t.jsxs("ul",{children:[t.jsxs("li",{children:[t.jsx("span",{className:"gl-dot cyan"}),"EQUANIMITY — alpha dominates. Score rises."]}),t.jsxs("li",{children:[t.jsx("span",{className:"gl-dot amber"}),"TEARING — beta rising. Slow your breath."]}),t.jsxs("li",{children:[t.jsx("span",{className:"gl-dot rose"}),"FRACTURED — score drops. Breathe deeply."]}),t.jsxs("li",{children:[t.jsx("span",{className:"gl-dot white"}),"SNAP — sharp exhale resets the room."]})]}),t.jsxs("p",{children:[t.jsx("strong",{children:"Challenge:"})," solve mental arithmetic to deliberately stress your brain, then recover."]})]}),t.jsxs("label",{className:"gl-toggle",children:[t.jsx("input",{type:"checkbox",checked:h,onChange:a=>A(a.target.checked)}),t.jsx("span",{children:"Mental challenge"})]}),h&&t.jsxs("div",{className:"gl-diff",children:[t.jsx("span",{className:"gl-diff-k",children:"DIFFICULTY"}),t.jsx("div",{className:"gl-diff-btns",children:[1,2,3,4,5].map(a=>t.jsx("button",{className:`gl-diff-btn ${o===a?"is-on":""}`,onClick:()=>_(a),children:a},a))})]})]}),!g.snapping&&t.jsx("div",{className:`gl-coaching lvl-${w}`,children:Q}),t.jsx("div",{className:"gl-calm-strip",style:{"--calm-pct":`${Math.round(g.calm*100)}%`,"--calm-color":w==="calm"?"var(--gl-cyan)":w==="drift"?"#c4f0ff":w==="tear"?"var(--gl-amber)":"var(--gl-rose)"}}),h&&f&&t.jsxs("div",{className:"glitch-puzzle",children:[t.jsxs("div",{className:"glitch-puzzle-q",children:[f.question," = ?"]}),t.jsx("input",{className:"glitch-puzzle-input",type:"text",inputMode:"numeric",autoFocus:!0,value:y,onChange:a=>m(a.target.value.replace(/[^0-9\-]/g,"")),onKeyDown:a=>{a.key==="Enter"&&P()},placeholder:"answer"}),t.jsxs("div",{className:"glitch-puzzle-meta",children:[t.jsxs("span",{className:`glitch-puzzle-timer ${O<2?"is-low":""}`,children:[O.toFixed(1),"s"]}),t.jsxs("span",{children:["streak ",f.streak]}),f.lastResult&&t.jsx("span",{className:`glitch-puzzle-flash is-${f.lastResult}`,children:f.lastResult==="correct"?"✓":"✗"})]})]})]})]})}export{ye as default};
