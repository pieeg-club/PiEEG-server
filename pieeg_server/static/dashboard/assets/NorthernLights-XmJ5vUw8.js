var _e=Object.defineProperty;var Ye=(o,e,t)=>e in o?_e(o,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):o[e]=t;var a=(o,e,t)=>Ye(o,typeof e!="symbol"?e+"":e,t);import{r as s,u as De,F as Ve,a as ge,j as z}from"./index-B_9UnxCJ.js";import{T as Ne,S as je,C as v,t as He,P as Xe,W as Qe,l as Ze,A as $e,B as Fe,a as be,b as Le,c as Te,p as re,u as Ee,k as xe,v as Me,w as Ke,s as ke}from"./three.module-jKfFDICU.js";const Ie=`
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(
    0.211324865405187,   // (3.0-sqrt(3.0))/6.0
    0.366025403784439,   // 0.5*(sqrt(3.0)-1.0)
   -0.577350269189626,   // -1.0 + 2.0 * C.x
    0.024390243902439    // 1.0 / 41.0
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                            + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
                           dot(x12.zw,x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`,Je=`
uniform float uTime;
uniform float uDelta;
uniform float uTheta;
uniform float uBeta;
uniform float uArcRadius;
uniform float uArcSpan;
uniform float uCenterY;
uniform float uHeight;

varying vec2 vUv;
varying float vRay;

${Ie}

void main() {
  vUv = uv;
  float t = uTime;

  // ── Map flat UV → cylindrical arc ──────────────────────────────────
  float angle = (uv.x - 0.5) * uArcSpan;
  float r     = uArcRadius;
  vec3 pos;
  pos.x = sin(angle) * r;
  pos.z = -cos(angle) * r;
  pos.y = uCenterY + (uv.y - 0.5) * uHeight;

  // ── Curtain wave motion ────────────────────────────────────────────
  float drape = pow(1.0 - uv.y, 1.5);                       // bottom hangs more
  float w1 = snoise(vec2(uv.x * 3.0 + t * 0.08, t * 0.05)) * 1.5;
  float w2 = snoise(vec2(uv.x * 5.0 - t * 0.12, uv.y * 2.0 + t * 0.03)) * 0.8;
  float w3 = sin(uv.x * 8.0 + t * 0.15) * 0.4;

  float wave = (w1 + w2 * (0.5 + uTheta) + w3 * (0.5 + uDelta))
             * (0.35 + drape * 0.65);

  // Beta drives faster turbulence
  float turb = snoise(vec2(uv.x * 8.0 + t * 0.3, uv.y * 4.0)) * uBeta * 0.6;
  wave += turb;

  // Push radially along the arc normal
  pos.x += sin(angle) * wave;
  pos.z += -cos(angle) * wave;

  // Slight vertical ripple
  pos.y += snoise(vec2(uv.x * 6.0, t * 0.1)) * 0.25 * drape;

  // ── Ray pattern (passed to fragment) ───────────────────────────────
  float rn = snoise(vec2(uv.x * 20.0, t * 0.05));
  vRay = sin(uv.x * 40.0 + rn * 3.0) * 0.5 + 0.5;
  vRay = pow(vRay, 0.5);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`,et=`
uniform float uTime;
uniform float uAlpha;
uniform float uGamma;
uniform float uIntensity;
uniform vec3  uColor1;          // lower colour  (green)
uniform vec3  uColor2;          // mid colour    (teal / purple)
uniform vec3  uColor3;          // upper colour  (blue / magenta)

varying vec2  vUv;
varying float vRay;

void main() {
  float t = vUv.y;                                           // 0 = bottom, 1 = top

  // ── Vertical colour gradient ───────────────────────────────────────
  vec3 col = mix(uColor1, uColor2, smoothstep(0.08, 0.55, t));
  col = mix(col, uColor3, smoothstep(0.45, 0.95, t) * 0.6);

  // Alpha (relaxation) boosts luminosity
  col *= 0.7 + uAlpha * 0.6;

  // ── Brightness profile — brightest near the lower curtain edge ─────
  float brightness = 1.0 - smoothstep(0.0, 0.8, t) * 0.55;

  // ── Edge fade ──────────────────────────────────────────────────────
  float ex = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
  float ey = smoothstep(0.0, 0.03, vUv.y) * smoothstep(1.0, 0.85, vUv.y);

  // ── Ray modulation ─────────────────────────────────────────────────
  float ray = mix(0.45, 1.0, vRay);

  // ── Gamma sparkle at the top edge ──────────────────────────────────
  float hash = fract(sin(dot(floor(vUv * 200.0), vec2(12.9898, 78.233)))
                     * 43758.5453);
  float sparkle = step(0.985, hash) * uGamma * 2.0;
  col += vec3(sparkle * 0.8, sparkle, sparkle * 0.9);

  // ── Composite ──────────────────────────────────────────────────────
  float a = uIntensity * brightness * ray * ex * ey;
  a = clamp(a, 0.0, 0.88);

  gl_FragColor = vec4(col, a);
}
`,tt=`
varying vec2 vUv;
varying vec3 vWorldPos;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,nt=`
uniform float uTime;
uniform vec3  uAuroraGlow;    // dominant aurora colour tint

varying vec2 vUv;
varying vec3 vWorldPos;

${Ie}

void main() {
  // Base snow colour — dark blue-grey
  vec3 snow = vec3(0.06, 0.07, 0.11);

  // Subtle noise texture
  float n = snoise(vWorldPos.xz * 0.3 + uTime * 0.01) * 0.5 + 0.5;
  snow += vec3(0.01, 0.012, 0.02) * n;

  // Aurora reflection — faint colour on the snow
  float dist = length(vWorldPos.xz);
  float falloff = 1.0 / (1.0 + dist * 0.06);
  snow += uAuroraGlow * 0.08 * falloff;

  // Distance fog
  float fog = smoothstep(5.0, 40.0, dist);
  snow = mix(snow, vec3(0.02, 0.025, 0.04), fog);

  gl_FragColor = vec4(snow, 1.0);
}
`;function J(o,e,t){return o<e?e:o>t?t:o}function d(o,e,t,i=.5){o.setTargetAtTime(e,t,i)}const at={masterVolume:.45,reverbMix:.6,delayTime:.6,delayFeedback:.4,sensitivity:2},M=77.78;class it{constructor(){a(this,"ctx",null);a(this,"master",null);a(this,"droneL",null);a(this,"droneR",null);a(this,"droneMerge",null);a(this,"droneGain",null);a(this,"padA",null);a(this,"padB",null);a(this,"padMod",null);a(this,"padModGain",null);a(this,"padGain",null);a(this,"windSrc",null);a(this,"windBP",null);a(this,"windLP",null);a(this,"windGain",null);a(this,"bowlA",null);a(this,"bowlB",null);a(this,"bowlBP",null);a(this,"bowlGain",null);a(this,"shimA",null);a(this,"shimB",null);a(this,"shimGain",null);a(this,"delay",null);a(this,"delayFb",null);a(this,"delaySend",null);a(this,"convolver",null);a(this,"wetGain",null);a(this,"dryGain",null);a(this,"ambWindSrc",null);a(this,"ambWindGain",null);a(this,"padLFO",null);a(this,"padLFOGain",null);a(this,"config",{...at});a(this,"_playing",!1);a(this,"_updateCount",0)}get playing(){return this._playing}async start(){if(this._playing)return;const e=new AudioContext;e.state==="suspended"&&await e.resume(),this.ctx=e;const t=e.currentTime;this.master=e.createGain(),this.master.gain.value=this.config.masterVolume,this.convolver=e.createConvolver(),this.convolver.buffer=this._impulse(e,5,2),this.wetGain=e.createGain(),this.wetGain.gain.value=this.config.reverbMix,this.dryGain=e.createGain(),this.dryGain.gain.value=1-this.config.reverbMix,this.master.connect(this.dryGain),this.dryGain.connect(e.destination),this.master.connect(this.convolver),this.convolver.connect(this.wetGain),this.wetGain.connect(e.destination),this.delay=e.createDelay(3),this.delay.delayTime.value=this.config.delayTime,this.delayFb=e.createGain(),this.delayFb.gain.value=this.config.delayFeedback,this.delaySend=e.createGain(),this.delaySend.gain.value=0,this.delaySend.connect(this.delay),this.delay.connect(this.delayFb),this.delayFb.connect(this.delay),this.delay.connect(this.master),this.droneL=e.createOscillator(),this.droneL.type="sine",this.droneL.frequency.value=M-1,this.droneR=e.createOscillator(),this.droneR.type="sine",this.droneR.frequency.value=M+1,this.droneMerge=e.createChannelMerger(2),this.droneGain=e.createGain(),this.droneGain.gain.value=0;const i=e.createBiquadFilter();i.type="lowpass",i.frequency.value=200,i.Q.value=.5,this.droneL.connect(this.droneMerge,0,0),this.droneR.connect(this.droneMerge,0,1),this.droneMerge.connect(i),i.connect(this.droneGain),this.droneGain.connect(this.master),this.droneL.start(t),this.droneR.start(t),this.padA=e.createOscillator(),this.padA.type="sine",this.padA.frequency.value=M*2,this.padB=e.createOscillator(),this.padB.type="sine",this.padB.frequency.value=M*2*1.005,this.padMod=e.createOscillator(),this.padMod.type="sine",this.padMod.frequency.value=M*3,this.padModGain=e.createGain(),this.padModGain.gain.value=0,this.padGain=e.createGain(),this.padGain.gain.value=0,this.padLFO=e.createOscillator(),this.padLFO.type="sine",this.padLFO.frequency.value=.07,this.padLFOGain=e.createGain(),this.padLFOGain.gain.value=3,this.padLFO.connect(this.padLFOGain),this.padLFOGain.connect(this.padA.frequency),this.padLFO.start(t),this.padMod.connect(this.padModGain),this.padModGain.connect(this.padA.frequency),this.padA.connect(this.padGain),this.padB.connect(this.padGain),this.padGain.connect(this.master),this.padMod.start(t),this.padA.start(t),this.padB.start(t);const c=this._noiseBuffer(e,6);this.windSrc=e.createBufferSource(),this.windSrc.buffer=c,this.windSrc.loop=!0,this.windBP=e.createBiquadFilter(),this.windBP.type="bandpass",this.windBP.frequency.value=350,this.windBP.Q.value=.8,this.windLP=e.createBiquadFilter(),this.windLP.type="lowpass",this.windLP.frequency.value=800,this.windLP.Q.value=.5,this.windGain=e.createGain(),this.windGain.gain.value=0,this.windSrc.connect(this.windBP),this.windBP.connect(this.windLP),this.windLP.connect(this.windGain),this.windGain.connect(this.master),this.windSrc.start(t),this.bowlA=e.createOscillator(),this.bowlA.type="triangle",this.bowlA.frequency.value=M*4,this.bowlB=e.createOscillator(),this.bowlB.type="triangle",this.bowlB.frequency.value=M*4*1.003,this.bowlBP=e.createBiquadFilter(),this.bowlBP.type="bandpass",this.bowlBP.frequency.value=900,this.bowlBP.Q.value=8,this.bowlGain=e.createGain(),this.bowlGain.gain.value=0,this.bowlA.connect(this.bowlBP),this.bowlB.connect(this.bowlBP),this.bowlBP.connect(this.bowlGain),this.bowlGain.connect(this.master),this.bowlGain.connect(this.delaySend),this.bowlA.start(t),this.bowlB.start(t),this.shimA=e.createOscillator(),this.shimA.type="sine",this.shimA.frequency.value=M*8,this.shimB=e.createOscillator(),this.shimB.type="sine",this.shimB.frequency.value=M*12,this.shimGain=e.createGain(),this.shimGain.gain.value=0,this.shimA.connect(this.shimGain),this.shimB.connect(this.shimGain),this.shimGain.connect(this.master),this.shimGain.connect(this.delaySend),this.shimA.start(t),this.shimB.start(t),this.ambWindSrc=e.createBufferSource(),this.ambWindSrc.buffer=c,this.ambWindSrc.loop=!0;const h=e.createBiquadFilter();h.type="lowpass",h.frequency.value=180,h.Q.value=.3,this.ambWindGain=e.createGain(),this.ambWindGain.gain.value=.03,this.ambWindSrc.connect(h),h.connect(this.ambWindGain),this.ambWindGain.connect(this.master),this.ambWindSrc.start(t),this._playing=!0}stop(){!this._playing||!this.ctx||(this._playing=!1,this.ctx.close(),this.ctx=null)}update(e){if(!this._playing||!this.ctx)return;const t=this.ctx.currentTime,i=this.config.sensitivity;this._updateCount++;const c=J(Math.log1p((e.Delta??0)*i)/6,0,1),h=J(Math.log1p((e.Theta??0)*i)/6,0,1),p=J(Math.log1p((e.Alpha??0)*i)/6,0,1),R=J(Math.log1p((e.Beta??0)*i)/6,0,1),m=J(Math.log1p((e.Gamma??0)*i)/6,0,1);d(this.droneGain.gain,.08+c*.2,t,.8);const G=.5+c*2.5;d(this.droneL.frequency,M-G,t,1),d(this.droneR.frequency,M+G,t,1),d(this.padGain.gain,h*.14,t,.6),d(this.padModGain.gain,h*M*.5,t,.8),d(this.padLFOGain.gain,2+h*6,t,1);const l=M*2*(1+h*.08);d(this.padA.frequency,l,t,1.2),d(this.padB.frequency,l*1.005,t,1.2),d(this.windGain.gain,p*.12,t,.6),d(this.windBP.frequency,250+p*1800,t,.8),d(this.windLP.frequency,500+p*2500,t,.8),d(this.ambWindGain.gain,.025+p*.04,t,.6),d(this.bowlGain.gain,R*.07,t,.5);const T=M*(4+R*2);d(this.bowlA.frequency,T,t,1),d(this.bowlB.frequency,T*1.003,t,1),d(this.bowlBP.frequency,600+R*1200,t,.8),d(this.shimGain.gain,m*.05,t,.4),d(this.shimA.frequency,M*(8+m*2),t,.8),d(this.shimB.frequency,M*(12+m*2),t,.8),d(this.delaySend.gain,(R+m)*.25,t,.5)}applyConfig(e){if(Object.assign(this.config,e),!this._playing||!this.ctx)return;const t=this.ctx.currentTime;e.masterVolume!==void 0&&d(this.master.gain,e.masterVolume,t,.3),e.reverbMix!==void 0&&(d(this.wetGain.gain,e.reverbMix,t,.3),d(this.dryGain.gain,1-e.reverbMix,t,.3)),e.delayTime!==void 0&&this.delay.delayTime.setTargetAtTime(e.delayTime,t,.2),e.delayFeedback!==void 0&&d(this.delayFb.gain,e.delayFeedback,t,.3)}_impulse(e,t,i){const c=Math.floor(e.sampleRate*t),h=e.createBuffer(i,c,e.sampleRate);for(let p=0;p<i;p++){const R=h.getChannelData(p);for(let m=0;m<c;m++){const G=(1-m/c)**3,l=m<e.sampleRate*.1?Math.sin(m*.02)*.3*(1-m/(e.sampleRate*.1)):0;R[m]=(Math.random()*2-1+l)*G}}return h}_noiseBuffer(e,t){const i=Math.floor(e.sampleRate*t),c=e.createBuffer(1,i,e.sampleRate),h=c.getChannelData(0);let p=0;for(let R=0;R<i;R++){const m=Math.random()*2-1;p=p*.97+m*.03,h[R]=p*10}return c}}const ot=256,rt=80;function st(o){const e=s.useRef(null),t=s.useRef(null),i=s.useRef(null),c=s.useRef(2),h=s.useRef({delta:0,theta:0,alpha:0,beta:0,gamma:0}),p=De();(!t.current||t.current.sampleRateHz!==p)&&(t.current=new Ve(ot,p)),e.current||(e.current=new it),s.useEffect(()=>{const l=t.current,T=e.current,te=setInterval(()=>{const{buffers:Y,writeIndex:se,samplesInBuffer:le,numChannels:Q}=o,C={};for(const S of ge)C[S.name]=0;let W=0;for(let S=0;S<Q;S++){const B=Y.current[S];if(!B)continue;const _=l.analyseRing(B,se.current,le.current);if(_){W++;for(const D of ge)C[D.name]+=_.bandPowers[D.name]??0}}if(W>0){for(const _ of ge)C[_.name]/=W;i.current=C,T.playing&&T.update(C);const S=c.current,B=h.current;B.delta=Math.min(Math.log1p((C.Delta??0)*S)/6,1),B.theta=Math.min(Math.log1p((C.Theta??0)*S)/6,1),B.alpha=Math.min(Math.log1p((C.Alpha??0)*S)/6,1),B.beta=Math.min(Math.log1p((C.Beta??0)*S)/6,1),B.gamma=Math.min(Math.log1p((C.Gamma??0)*S)/6,1)}},rt);return()=>clearInterval(te)},[o]);const R=s.useCallback(async()=>{const l=e.current;l.playing||(await l.start(),c.current=l.config.sensitivity)},[]),m=s.useCallback(()=>{var l;(l=e.current)==null||l.stop()},[]),G=s.useCallback(l=>{var T;(T=e.current)==null||T.applyConfig(l),l.sensitivity!==void 0&&(c.current=l.sensitivity)},[]);return s.useEffect(()=>()=>{var l;(l=e.current)==null||l.stop()},[]),{start:R,stop:m,applyConfig:G,latestBP:i,normalised:h,get playing(){var l;return((l=e.current)==null?void 0:l.playing)??!1},get config(){var l;return(l=e.current)==null?void 0:l.config}}}const ye=1200,ee=300,Ce=[80,50],we=[{arcRadius:10,arcSpan:4.2,centerY:8,height:6,color1:new v(.15,.95,.4),color2:new v(.2,.75,.85),color3:new v(.55,.2,.85),rotY:0,intensity:.75},{arcRadius:12,arcSpan:3.6,centerY:9.5,height:5,color1:new v(.1,.8,.55),color2:new v(.4,.25,.9),color3:new v(.8,.2,.55),rotY:Math.PI*2/3,intensity:.5},{arcRadius:14,arcSpan:3.2,centerY:11,height:4,color1:new v(.2,.6,.9),color2:new v(.6,.15,.7),color3:new v(.85,.35,.55),rotY:Math.PI*4/3,intensity:.35},{arcRadius:11,arcSpan:5,centerY:6.5,height:4,color1:new v(.1,.7,.35),color2:new v(.15,.6,.7),color3:new v(.3,.2,.6),rotY:Math.PI,intensity:.3},{arcRadius:9,arcSpan:5.6,centerY:13,height:3,color1:new v(.3,.9,.7),color2:new v(.7,.3,.8),color3:new v(.5,.15,.9),rotY:Math.PI/2,intensity:.25},{arcRadius:13,arcSpan:3,centerY:7,height:5,color1:new v(.05,.85,.3),color2:new v(.1,.5,.8),color3:new v(.4,.1,.7),rotY:-Math.PI/3,intensity:.4}];function lt(o){const e=new Me(1,1,Ce[0],Ce[1]),t=new Ee({vertexShader:Je,fragmentShader:et,transparent:!0,depthWrite:!1,blending:re,side:ke,uniforms:{uTime:{value:0},uDelta:{value:0},uTheta:{value:0},uAlpha:{value:0},uBeta:{value:0},uGamma:{value:0},uIntensity:{value:o.intensity},uArcRadius:{value:o.arcRadius},uArcSpan:{value:o.arcSpan},uCenterY:{value:o.centerY},uHeight:{value:o.height},uColor1:{value:o.color1},uColor2:{value:o.color2},uColor3:{value:o.color3}}}),i=new xe(e,t);return i.rotation.y=o.rotY,i.frustumCulled=!1,i}function ct(){const o=new Float32Array(ee*3),e=new Float32Array(ee);for(let c=0;c<ee;c++){const h=Math.random()*Math.PI*2,p=3+Math.random()*14;o[c*3]=Math.cos(h)*p,o[c*3+1]=4+Math.random()*10,o[c*3+2]=Math.sin(h)*p,e[c]=.005+Math.random()*.015}const t=new Fe;t.setAttribute("position",new be(o,3));const i=new Te({size:.06,color:8978363,transparent:!0,opacity:.6,sizeAttenuation:!0,blending:re,depthWrite:!1});return{points:new Le(t,i),positions:o,velocities:e}}function ft({eegData:o,onExit:e}){const t=s.useRef(null),i=s.useRef(null),c=s.useRef(null),h=s.useRef(null),p=s.useRef([]),R=s.useRef(null),m=s.useRef(null),G=s.useRef(null),l=s.useRef(!1),T=s.useRef(new Ne),te=s.useRef(null),Y=s.useRef(null),[se,le]=s.useState(!1),[Q,C]=s.useState(!1),[W,S]=s.useState(!1),B=st(o),_=B.normalised,D=s.useRef(e);D.current=e;const Re=s.useCallback(()=>{if(l.current)return;l.current=!0,m.current&&(m.current.end().catch(()=>{}),m.current=null),G.current!=null&&(cancelAnimationFrame(G.current),G.current=null);const f=i.current;f&&(f.xr.enabled=!1,f.setAnimationLoop(null),f.dispose(),i.current=null),p.current=[]},[]),ce=s.useCallback(async()=>{W?(B.stop(),S(!1)):(await B.start(),S(!0))},[W,B]);s.useEffect(()=>{var f;(f=navigator.xr)==null||f.isSessionSupported("immersive-vr").then(x=>le(x)).catch(()=>{})},[]),s.useEffect(()=>{const f=x=>{x.key==="Escape"&&D.current(),x.key===" "&&(x.preventDefault(),ce())};return window.addEventListener("keydown",f),()=>window.removeEventListener("keydown",f)},[ce]),s.useEffect(()=>{const f=t.current;if(!f)return;l.current=!1;const x=T.current,F=new je;F.background=new v(66057),F.fog=new He(66057,.012),c.current=F;const E=new Xe(80,window.innerWidth/window.innerHeight,.05,80);E.position.set(0,1.6,0),h.current=E;const y=new Qe({antialias:!0,alpha:!1});y.setPixelRatio(Math.min(window.devicePixelRatio,1.5)),y.setSize(window.innerWidth,window.innerHeight),y.xr.enabled=!0,y.toneMapping=Ze,y.toneMappingExposure=1.2,f.appendChild(y.domElement),i.current=y,F.add(new $e(1122884,.3));const V=new Float32Array(ye*3),N=new Float32Array(ye*3),k=new v;for(let n=0;n<ye;n++){const r=18+Math.random()*22,q=Math.random()*Math.PI*2,w=Math.acos(Math.random());V[n*3]=r*Math.sin(w)*Math.cos(q),V[n*3+1]=r*Math.sin(w)*Math.sin(q)+2,V[n*3+2]=r*Math.cos(w);const g=.7+Math.random()*.3;k.setHSL(.6+Math.random()*.15,.15,g),N[n*3]=k.r,N[n*3+1]=k.g,N[n*3+2]=k.b}const L=new Fe;L.setAttribute("position",new be(V,3)),L.setAttribute("color",new be(N,3));const A=new Le(L,new Te({size:.04,vertexColors:!0,transparent:!0,opacity:.85,sizeAttenuation:!0,blending:re,depthWrite:!1}));F.add(A);const I=new Ee({vertexShader:tt,fragmentShader:nt,uniforms:{uTime:{value:0},uAuroraGlow:{value:new v(.15,.9,.4)}}}),j=new xe(new Me(80,80,1,1),I);j.rotation.x=-Math.PI/2,j.position.y=0,F.add(j);const b=[];for(const n of we){const r=lt(n);F.add(r),b.push(r)}p.current=b;const H=ct();F.add(H.points),R.current=H;const Oe=new Ke({color:667162,transparent:!0,opacity:.2,blending:re,depthWrite:!1,side:ke}),ne=new xe(new Me(60,6),Oe);ne.position.set(0,3,-12),F.add(ne);function We(n,r){for(const u of b){const P=u.material.uniforms;P.uTime.value=n,P.uDelta.value=r.delta,P.uTheta.value=r.theta,P.uAlpha.value=r.alpha,P.uBeta.value=r.beta,P.uGamma.value=r.gamma;const me=we[b.indexOf(u)];P.uIntensity.value=me.intensity*(.6+r.alpha*.5+r.delta*.15)}const q=j.material.uniforms;q.uTime.value=n,q.uAuroraGlow.value.setRGB(.1+r.beta*.2,.6+r.alpha*.3,.3+r.theta*.3),ne.material.color.setRGB(.04+r.gamma*.06,.18+r.alpha*.15,.1+r.theta*.08),ne.material.opacity=.15+r.alpha*.15;const g=H.positions,U=H.velocities;for(let u=0;u<ee;u++)g[u*3+1]+=U[u]*(1+r.gamma*2),g[u*3]+=Math.sin(n*.2+u)*.002,g[u*3+2]+=Math.cos(n*.15+u*.7)*.002,g[u*3+1]>16&&(g[u*3]=(Math.random()-.5)*20,g[u*3+1]=4+Math.random()*2,g[u*3+2]=(Math.random()-.5)*20);H.points.geometry.attributes.position.needsUpdate=!0;const O=H.points.material;O.opacity=.35+r.gamma*.5,O.color.setRGB(.5+r.gamma*.3,1,.7+r.theta*.3),A.rotation.y=n*.002}function ze(n,r,q,w){n.clearRect(0,0,r,q);const g=72,U=q-g;n.fillStyle="rgba(2,2,12,0.45)",n.fillRect(0,U,r,g),n.fillStyle="rgba(100,255,180,0.06)",n.fillRect(0,U,r,1);const O=[{label:"δ",val:w.delta,color:"#5588cc"},{label:"θ",val:w.theta,color:"#44ccaa"},{label:"α",val:w.alpha,color:"#66ff99"},{label:"β",val:w.beta,color:"#aa88ff"},{label:"γ",val:w.gamma,color:"#ff77cc"}],u=18,P=72,me=r/2-(O.length-1)*P/2,Z=U+g/2;for(let ie=0;ie<O.length;ie++){const $=O[ie],K=me+ie*P;n.beginPath(),n.arc(K,Z,u,Math.PI*.8,Math.PI*2.2),n.strokeStyle="rgba(255,255,255,0.08)",n.lineWidth=3,n.stroke();const Ue=Math.PI*1.4,ve=Math.PI*.8+Ue*$.val;n.beginPath(),n.arc(K,Z,u,Math.PI*.8,ve),n.strokeStyle=$.color,n.lineWidth=3,n.lineCap="round",n.stroke(),n.beginPath(),n.arc(K+Math.cos(ve)*u,Z+Math.sin(ve)*u,3,0,Math.PI*2),n.fillStyle=$.color,n.fill(),n.fillStyle="rgba(255,255,255,0.7)",n.font="bold 13px 'Inter', system-ui, sans-serif",n.textAlign="center",n.textBaseline="middle",n.fillText($.label,K,Z),n.fillStyle="rgba(255,255,255,0.35)",n.font="9px 'Inter', system-ui, sans-serif",n.fillText(($.val*100).toFixed(0)+"%",K,Z+u+12)}n.fillStyle="rgba(130,255,200,0.6)",n.font="bold 14px 'Inter', system-ui, sans-serif",n.textAlign="left",n.textBaseline="top",n.fillText("NORTHERN LIGHTS",16,14),n.fillStyle="rgba(255,255,255,0.25)",n.font="10px 'Inter', system-ui, sans-serif",n.fillText("neural aurora borealis",16,32)}let ue=!1,he=0,de=0,fe=0,ae=.35,pe=!0;const X=y.domElement,Ge=n=>{ue=!0,pe=!1,he=n.clientX,de=n.clientY},Ae=()=>{ue=!1},Se=n=>{ue&&(fe-=(n.clientX-he)*.003,ae-=(n.clientY-de)*.003,ae=Math.max(-.2,Math.min(Math.PI/2.2,ae)),he=n.clientX,de=n.clientY)};X.addEventListener("pointerdown",Ge),X.addEventListener("pointerup",Ae),X.addEventListener("pointermove",Se);function Be(){pe=!0;function n(){x.update();const r=x.getElapsed();pe&&(fe=r*.015),E.rotation.order="YXZ",E.rotation.y=fe,E.rotation.x=ae;const q=_.current;We(r,q),y.render(F,E);const w=te.current;if(w){const g=window.devicePixelRatio||1,U=w.getBoundingClientRect(),O=U.width,u=U.height;(w.width!==O*g||w.height!==u*g)&&(w.width=O*g,w.height=u*g);const P=w.getContext("2d");P&&(P.setTransform(g,0,0,g,0,0),ze(P,O,u,q))}G.current=requestAnimationFrame(n)}G.current=requestAnimationFrame(n)}Y.current=Be,Be();const Pe=()=>{i.current&&(E.aspect=window.innerWidth/window.innerHeight,E.updateProjectionMatrix(),y.setSize(window.innerWidth,window.innerHeight))};return window.addEventListener("resize",Pe),()=>{window.removeEventListener("resize",Pe),X.removeEventListener("pointerdown",Ge),X.removeEventListener("pointerup",Ae),X.removeEventListener("pointermove",Se),Re(),f.contains(y.domElement)&&f.removeChild(y.domElement)}},[]);const qe=s.useCallback(async()=>{const f=i.current;if(!(!f||!navigator.xr))try{const x=await navigator.xr.requestSession("immersive-vr",{optionalFeatures:["local-floor","bounded-floor","hand-tracking"]});m.current=x,C(!0),G.current!=null&&(cancelAnimationFrame(G.current),G.current=null),await f.xr.setSession(x),x.addEventListener("end",()=>{var k;m.current=null,C(!1),f.setAnimationLoop(null),f.xr.enabled=!1,f.xr.enabled=!0,(k=Y.current)==null||k.call(Y)}),x.addEventListener("squeeze",()=>{x.end().catch(()=>{})});const F=T.current,E=p.current,y=R.current,V=c.current,N=h.current;f.setAnimationLoop(()=>{F.update();const k=F.getElapsed(),L=_.current;for(let A=0;A<E.length;A++){const I=E[A].material.uniforms;I.uTime.value=k,I.uDelta.value=L.delta,I.uTheta.value=L.theta,I.uAlpha.value=L.alpha,I.uBeta.value=L.beta,I.uGamma.value=L.gamma,I.uIntensity.value=we[A].intensity*(.6+L.alpha*.5+L.delta*.15)}if(y){const A=y.positions,I=y.velocities;for(let b=0;b<ee;b++)A[b*3+1]+=I[b]*(1+L.gamma*2),A[b*3]+=Math.sin(k*.2+b)*.002,A[b*3+2]+=Math.cos(k*.15+b*.7)*.002,A[b*3+1]>16&&(A[b*3]=(Math.random()-.5)*20,A[b*3+1]=4+Math.random()*2,A[b*3+2]=(Math.random()-.5)*20);y.points.geometry.attributes.position.needsUpdate=!0;const j=y.points.material;j.opacity=.35+L.gamma*.5}f.render(V,N)})}catch(x){console.warn("Failed to enter VR:",x)}},[]);return z.jsxs("div",{style:{position:"fixed",inset:0,background:"#010209",zIndex:1e3},children:[z.jsx("div",{ref:t,style:{position:"absolute",inset:0}}),z.jsx("canvas",{ref:te,style:{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none",zIndex:1}}),z.jsxs("div",{style:{position:"absolute",top:12,right:12,display:"flex",gap:8,zIndex:2},children:[z.jsx("button",{onClick:()=>{Re(),B.stop(),D.current()},style:oe,children:"✕ Exit"}),z.jsx("button",{onClick:ce,style:{...oe,background:W?"rgba(100,255,180,0.15)":"rgba(255,255,255,0.08)",borderColor:W?"rgba(100,255,180,0.4)":"rgba(255,255,255,0.15)"},children:W?"♫ Sound On":"♪ Sound Off"}),se&&!Q&&z.jsx("button",{onClick:qe,style:{...oe,background:"rgba(100,180,255,0.15)",borderColor:"rgba(100,180,255,0.4)"},children:"▶ Enter VR"}),Q&&z.jsx("span",{style:{...oe,background:"rgba(100,255,180,0.12)",borderColor:"rgba(100,255,180,0.35)",cursor:"default"},children:"VR Active"})]}),!Q&&z.jsx("div",{style:{position:"absolute",bottom:84,left:"50%",transform:"translateX(-50%)",color:"rgba(255,255,255,0.2)",fontSize:11,zIndex:2,fontFamily:"'Inter', system-ui, sans-serif",letterSpacing:1},children:"SPACE — toggle sound · DRAG — look around · ESC — exit"})]})}const oe={padding:"8px 16px",fontSize:13,fontFamily:"'Inter', system-ui, sans-serif",fontWeight:500,color:"rgba(255,255,255,0.85)",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,cursor:"pointer",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",lineHeight:1};export{ft as default};
