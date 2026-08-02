/**
 * audio.js - 语音合成（TTS）和录音功能
 *
 * 朗读引擎支持两种：
 *  1. 系统语音（Web Speech API）——离线、免流量，但依赖设备是否装有韩语语音包
 *  2. 在线发音（有道 / 百度韩语 TTS）——手机/平板没有韩语语音时自动启用，需联网
 *
 * 发音方式可在「我的」页切换：自动（推荐）/ 在线发音 / 系统发音
 * 录音使用 MediaRecorder API
 */

const Audio = (() => {

    let synthesis = null;
    let koreanVoice = null;
    let voicesLoaded = false;
    let onlineAudio = null;          // 当前在线播放的 audio 元素
    let onlineSeq = 0;               // 在线播放序号（用于打断旧播放的回调）
    let lastErr = '';                // 最近一次在线发音失败原因（诊断用）

    const TTS_MODE_KEY = 'km_tts_mode';
    const TTS_MODES = ['auto', 'online', 'local'];
    let ttsMode = 'auto';            // 'auto' | 'online' | 'local'

    // 在线韩语 TTS 引擎：仅保留百度（国内可直连、返回 audio/mpeg）。
    // 注：有道 dictvoice(type=2) 对韩语恒返回 500，已移除，避免浪费 800ms 切换。
    // 百度直连不需要 CORS，<video> 可直接播放；SW 不拦截该跨域请求（拦截并回传 opaque 响应会导致 Chromium 系无法播放）。
    const ONLINE_TTS = [
        { name: '百度', build: t => 'https://fanyi.baidu.com/gettts?lan=kor&text=' + encodeURIComponent(t) + '&spd=3&source=web' }
    ];

    // 移动端判断（Android / iOS / 平板）
    // 注意：很多安卓平板的 UA 不含 Mobile/Tablet 字样（如 "Mozilla/5.0 (Linux; Android 13; ...)"），
    // 必须同时用触屏检测兜底，否则平板会被当成桌面 → auto 模式误走系统语音（无声）
    function isMobile() {
        const ua = navigator.userAgent || '';
        if (/Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua)) return true;
        try {
            if (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)) return true;
        } catch (e) { /* 忽略 */ }
        return false;
    }

    // 初始化语音合成
    function init() {
        try {
            const saved = localStorage.getItem(TTS_MODE_KEY);
            if (saved && TTS_MODES.indexOf(saved) >= 0) ttsMode = saved;
        } catch (e) { /* 忽略 */ }
        if ('speechSynthesis' in window) {
            synthesis = window.speechSynthesis;
            loadVoices();
            // 某些浏览器异步加载语音列表
            synthesis.onvoiceschanged = loadVoices;
        }
        // 初始化导入词音频缓存（IndexedDB）
        try { TtsCache.init().catch(() => {}); } catch (e) { /* 忽略 */ }
    }

    function loadVoices() {
        if (!synthesis) return;
        const voices = synthesis.getVoices();
        koreanVoice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('ko')) || null;
        voicesLoaded = true;
    }

    function getMode() { return ttsMode; }

    function setMode(m) {
        if (TTS_MODES.indexOf(m) < 0) m = 'auto';
        ttsMode = m;
        try { localStorage.setItem(TTS_MODE_KEY, m); } catch (e) { /* 忽略 */ }
    }

    function hasKoreanVoice() { return !!koreanVoice; }

    // 当前是否走系统语音
    function useLocalNow() {
        if (ttsMode === 'local') return true;
        if (ttsMode === 'online') return false;
        // auto：移动端优先在线（安卓的 speechSynthesis 常「假支持」韩语：列得出来但发不出声）；
        // 桌面（Chrome 内置 Google 韩语语音）用系统，没有韩语语音时回退在线。
        if (isMobile()) return false;
        return hasKoreanVoice();
    }

    // 常驻播放元素：用 <video> 而非 <audio>！
    // 关键：夸克浏览器对 display:none 的 <audio> 元素静默不出声（bilibili 用 <video> 却能响），
    // <video> 可正常播放音频文件（MP3），且屏幕外定位（非 display:none）避免被浏览器特殊对待。
    let audioEl = null;
    function ensureAudioEl() {
        if (audioEl && audioEl.isConnected) return audioEl;
        try {
            audioEl = document.createElement('video');
            audioEl.preload = 'auto';
            // 屏幕外定位，保持「可见媒体」身份，规避 display:none 被静音/拦截
            audioEl.style.position = 'fixed';
            audioEl.style.left = '-9999px';
            audioEl.style.width = '2px';
            audioEl.style.height = '2px';
            audioEl.style.opacity = '0.01';
            audioEl.style.pointerEvents = 'none';
            audioEl.style.zIndex = '-1';
            audioEl.setAttribute('playsinline', '');
            audioEl.setAttribute('webkit-playsinline', '');
            audioEl.setAttribute('x5-playsinline', '');
            (document.body || document.documentElement).appendChild(audioEl);
        } catch (e) { /* 忽略 */ }
        return audioEl;
    }

    /**
     * 清理文本以适配 TTS 接口：
     * 词库中语法词含 --前缀、(括号)、/斜杠、?问号、.句号 等，
     * 这些会导致有道/百度 TTS 返回错误或空音频。
     * 例: "--(으)ㄹ까요?" → "ㄹ까요", "맛(이)있다" → "맛있다", "나/저" → "나"
     */
    function cleanTextForTTS(text) {
        if (!text) return '';
        let t = text;
        // 去掉开头的 -- 或 -
        t = t.replace(/^--?/g, '');
        // 去掉括号内容（(으)、(이)、(무엇을) 等），保留括号外的文字
        t = t.replace(/\([^)]*\)/g, '');
        // 斜杠分隔的取第一个（나/저 → 나, -아/어 보다 → 아 보다）
        t = t.split('/')[0];
        // 去掉末尾标点
        t = t.replace(/[?.!。？！,\s]+$/g, '');
        t = t.trim();
        // 如果清理后没有韩文字符了，回退：去掉括号符号但保留内容
        if (!/[\uAC00-\uD7A3]/.test(t)) {
            t = text.replace(/^--?/g, '').replace(/[()]/g, '').split('/')[0].replace(/[?.!。？！]+$/g, '').trim();
        }
        return t || text.trim();
    }

    /**
     * 朗读韩语文本
     * @param {string} text - 要朗读的文本
     * @param {number} rate - 语速（0.5-2.0，默认0.9）
     * @returns {Promise<boolean>} 是否成功开始播放
     */
    /**
     * 朗读：优先播放用户录音（如有），无录音则走 TTS。
     * wordId 可选 —— 传了会先查内存缓存（同步），有录音才异步播放；
     * 无录音时直接走 TTS，不引入异步等待，保留移动端手势栈。
     */
    // 本地发音包：音频托管在独立仓库 + jsDelivr CDN（不再打包进 GitHub Pages，避免大仓库构建卡顿）。
    // 多个 CDN 兜底，确保国内可达；首次加载后由 Service Worker 缓存，离线也能播。
    const CDN_BASES = [
        'https://cdn.jsdelivr.net/gh/chi25798/korean-audio@main/audio/',
        'https://fastly.jsdelivr.net/gh/chi25798/korean-audio@main/audio/',
        'https://gcore.jsdelivr.net/gh/chi25798/korean-audio@main/audio/',
        'https://raw.githubusercontent.com/chi25798/korean-audio/main/audio/'
    ];
    const AUDIO_BASE = CDN_BASES[0];  // 兼容旧引用（默认主 CDN）

    // 文本 -> 本地音频文件名 索引（ko_index.json，约 67KB，覆盖 3148 个内置词）
    // 导入词的韩语文本若与内置词相同，即可直接命中本地发音；
    // 全新词经「桌面补录脚本」下载后也会写入该索引，实现纯本地离线发音。
    let koIndex = null;
    let koIndexLoading = null;
    function loadKoIndex() {
        if (koIndex) return Promise.resolve(koIndex);
        if (koIndexLoading) return koIndexLoading;
        const tryFetch = (i) => {
            if (i >= CDN_BASES.length) return Promise.resolve({});
            const url = CDN_BASES[i] + 'ko_index.json';
            return fetch(url)
                .then((r) => (r && r.ok ? r.json() : Promise.reject()))
                .then((j) => j || {})
                .catch(() => tryFetch(i + 1));
        };
        koIndexLoading = tryFetch(0)
            .then((j) => { koIndex = j || {}; return koIndex; })
            .catch(() => { koIndex = {}; return koIndex; });
        return koIndexLoading;
    }
    async function lookupKo(text) {
        const t = (text || '').trim();
        if (!t) return null;
        try { await loadKoIndex(); } catch (e) { /* 忽略 */ }
        if (koIndex && koIndex[t]) return koIndex[t];
        return null;
    }

    // 内置发音包走 CDN：用 fetch 拉成 blob 再本地播放，彻底绕开「媒体元素跨域」的坑
    // （SW 若用 cors 模式重新请求媒体元素发起的 no-cors 请求，浏览器会拒绝用于播放）。
    // 拉到的 blob 缓存进 IndexedDB（TtsCache），播过一次即离线可播；本会话再加一层内存缓存避免重复下载。
    const builtinURLCache = new Map();   // filename -> objectURL（本会话复用）

    async function fetchBuiltinBlob(filename) {
        for (let i = 0; i < CDN_BASES.length; i++) {
            const url = CDN_BASES[i] + encodeURIComponent(filename) + '.mp3';
            try {
                const ctrl = ('AbortController' in window) ? new AbortController() : null;
                const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, 8000) : null;
                const r = await fetch(url, ctrl ? { signal: ctrl.signal, mode: 'cors' } : { mode: 'cors' });
                if (timer) clearTimeout(timer);
                if (!r || !r.ok) continue;
                const blob = await r.blob();
                if (!blob || blob.size < 500) continue;   // 太小多半是错误页
                return blob;
            } catch (e) { /* 该 CDN 失败，试下一个 */ }
        }
        return null;
    }

    // 播放本地发音包音频（CDN 上的 <filename>.mp3，转 blob 后本地播放）。
    async function playLocalFile(filename, rate) {
        if (!filename) return false;
        let url = builtinURLCache.get(filename) || TtsCache.getURL(filename);
        if (!url) {
            const blob = await fetchBuiltinBlob(filename);
            if (!blob) return false;
            try { url = URL.createObjectURL(blob); builtinURLCache.set(filename, url); } catch (e) { return false; }
            TtsCache.save(filename, blob).catch(() => {});   // 后台持久化，失败不影响本次发音
        }
        return playBlobURL(url, rate);
    }

    const isBuiltinId = (id) => id && /^w-\d/.test(id);

    // ===== 导入词音频缓存（CORS 代理下载到 IndexedDB，离线可播） =====
    // 导入的全新词（教材里没有的）本地无 MP3，在线 TTS（百度/有道）无 CORS 头，
    // 移动端无法稳定播放其 opaque 响应。改用「CORS 代理」拿到真实音频 blob 存 IndexedDB，
    // 首次联网下载后、离线也能播；代理地址可在「我的」页配置（默认公共代理）。
    const TTS_PROXY_KEY = 'km_tts_proxy';
    function getProxy() {
        let p = '';
        try { p = localStorage.getItem(TTS_PROXY_KEY) || ''; } catch (e) { /* 忽略 */ }
        return p || 'https://api.allorigins.win/raw?url=';
    }
    function setProxy(url) {
        try {
            if (url && url.trim()) localStorage.setItem(TTS_PROXY_KEY, url.trim());
            else localStorage.removeItem(TTS_PROXY_KEY);
        } catch (e) { /* 忽略 */ }
    }

    const TtsCache = (() => {
        const DB_NAME = 'korean-memorizer-ttscache';
        const STORE = 'tts';
        const DB_VERSION = 1;
        let db = null;
        const cache = new Map();   // text(原始) -> blobURL
        function init() {
            return new Promise((resolve) => {
                if (!('indexedDB' in window)) { resolve(false); return; }
                try {
                    const req = indexedDB.open(DB_NAME, DB_VERSION);
                    req.onupgradeneeded = (e) => {
                        const d = e.target.result;
                        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
                    };
                    req.onsuccess = (e) => {
                        db = e.target.result;
                        try {
                            const st = db.transaction(STORE, 'readonly').objectStore(STORE);
                            const blobs = st.getAll();
                            const keys = st.getAllKeys();
                            blobs.onsuccess = () => {
                                const arr = blobs.result || [];
                                keys.onsuccess = () => {
                                    const ks = keys.result || [];
                                    ks.forEach((k, i) => { if (arr[i]) cache.set(k, URL.createObjectURL(arr[i])); });
                                    resolve(true);
                                };
                                keys.onerror = () => resolve(true);
                            };
                            blobs.onerror = () => resolve(true);
                        } catch (err) { resolve(true); }
                    };
                    req.onerror = () => resolve(false);
                } catch (e) { resolve(false); }
            });
        }
        function save(text, blob) {
            return new Promise((resolve) => {
                if (!db) { resolve(false); return; }
                try {
                    const r = db.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, text);
                    r.onsuccess = () => { cache.set(text, URL.createObjectURL(blob)); resolve(true); };
                    r.onerror = () => resolve(false);
                } catch (e) { resolve(false); }
            });
        }
        function getURL(text) { return cache.get(text) || null; }
        function has(text) { return cache.has(text); }
        function clearAll() {
            return new Promise((resolve) => {
                cache.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* 忽略 */ } });
                cache.clear();
                if (!db) { resolve(false); return; }
                try {
                    const r = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
                    r.onsuccess = () => resolve(true);
                    r.onerror = () => resolve(false);
                } catch (e) { resolve(false); }
            });
        }
        return { init, save, getURL, has, clearAll };
    })();

    /** 通过 CORS 代理下载韩语 TTS 音频（真实 blob），存入 IndexedDB，返回 blobURL。
     *  带 6s 超时（AbortController），代理失效时快速失败、绝不阻塞发音。 */
    async function fetchTTSViaProxy(text) {
        const cleaned = cleanTextForTTS(text);
        if (!cleaned) return null;
        const baidu = ONLINE_TTS[0].build(cleaned);
        const proxy = getProxy();
        const url = proxy + encodeURIComponent(baidu);
        const ctrl = ('AbortController' in window) ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 6000) : null;
        try {
            const r = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
            if (!r || !r.ok) return null;
            const blob = await r.blob();
            if (!blob || blob.size < 800) return null;   // 太小多半是错误页/HTML
            await TtsCache.save(text, blob);
            return TtsCache.getURL(text);
        } catch (e) { return null; }
        finally { if (timer) clearTimeout(timer); }
    }

    /** 后台不阻塞地尝试用代理缓存导入词音频（仅当用户配置了可用代理才有意义；
     *  默认公共代理 allorigins 已失效，直接跳过以免浪费）。 */
    function cacheImportInBackground(text) {
        try {
            const proxy = getProxy();
            if (!proxy || proxy === 'https://api.allorigins.win/raw?url=') return;
            fetchTTSViaProxy(text).catch(() => {});
        } catch (e) { /* 忽略 */ }
    }

    /** 用常驻 video 元素播放 blobURL */
    function playBlobURL(url, rate) {
        return new Promise((resolve) => {
            const a = ensureAudioEl();
            if (!a) { resolve(false); return; }
            let settled = false;
            const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
            a.onplaying = () => finish(true);
            a.onerror = () => finish(false);
            a.volume = 1; a.muted = false;
            try { a.playbackRate = rate || 1; } catch (e) { /* 忽略 */ }
            a.src = url; a.load();
            const p = a.play();
            if (p && p.then) p.then(() => setTimeout(() => { if (!settled) finish(true); }, 300)).catch(() => finish(false));
            setTimeout(() => finish(false), 4000);
        });
    }

    /** 导入成功后：后台为新词预下载音频（不阻塞 UI，失败静默） */
    function precacheImport(texts) {
        if (!texts || !texts.length) return;
        const seen = new Set();
        texts.forEach((t) => {
            if (!t || seen.has(t) || TtsCache.has(t)) return;
            seen.add(t);
            fetchTTSViaProxy(t).catch(() => {});   // 静默后台下载
        });
    }


    async function speak(text, rate = 0.9, wordId = null) {
        // 0. 用户自己的录音优先
        if (wordId && window.Recordings && Recordings.hasCached(wordId)) {
            try {
                const ok = await Recordings.play(wordId);
                if (ok) return true;
            } catch (e) { /* 忽略，回退 TTS */ }
        }
        const korean = text || '';
        // 1. 内置词：按 wordId 直接播本地音频（离线可靠）
        if (isBuiltinId(wordId)) {
            try {
                const ok = await playLocalFile(wordId, rate);
                if (ok) return true;
            } catch (e) { /* 忽略，回退 */ }
        }
        // 2. 按韩语文本查 ko_index -> 本地音频
        //    （导入词若文本命中教材词，立刻纯本地响；全新词经补录脚本也可命中）
        if (korean) {
            const fn = await lookupKo(korean);
            if (fn) {
                try {
                    const ok = await playLocalFile(fn, rate);
                    if (ok) return true;
                } catch (e) { /* 忽略，回退 */ }
            }
        }
        // 2.5 已缓存的导入词音频（IndexedDB，之前用代理下载成功过）
        if (korean) {
            const cachedURL = TtsCache.getURL(korean);
            if (cachedURL) {
                try { if (await playBlobURL(cachedURL, rate)) return true; } catch (e) { /* 忽略，回退 */ }
            }
        }
        if (!text) return false;
        // 3. 在线发音（百度直连，立即可播，无需 CORS）
        //    SW 不拦截该跨域请求，<video> 原生直连播放；导入全新词需联网（或预生成本地音频包实现离线）。
        //    ⚠️ 关键：绝不在这里 await CORS 代理下载——公共代理常失效/超时，会把发音卡住没声音。
        //       代理缓存仅作为「后台不阻塞」的加分项（见 cacheImportInBackground）。
        try {
            const ok = await speakOnline(korean, rate);
            if (ok) {
                cacheImportInBackground(korean);   // 失败不影响本次发音
                return true;
            }
        } catch (e) { /* 忽略，回退下方 */ }
        // 4. 系统语音兜底（桌面有韩语语音包 / 或用户强制「系统发音」模式）
        if (useLocalNow() && synthesis) {
            return speakLocal(text, rate);
        }
        return false;
    }

    /**
     * 系统语音朗读（带验证）：
     * 安卓 speechSynthesis 常「假支持」韩语（有 voice 但发不出声也不报错），
     * 用 onstart 事件 + 1.5s 超时验证是否真实开始朗读，失败自动回退在线发音。
     * @returns {Promise<boolean>}
     */
    function speakLocal(text, rate) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                resolve(ok);
            };
            let u = null;
            try {
                synthesis.cancel();
                u = new SpeechSynthesisUtterance(text);
                u.lang = 'ko-KR';
                u.rate = rate;
                u.pitch = 1.0;
                if (koreanVoice) u.voice = koreanVoice;
                u.onstart = () => finish(true);   // 真实开始朗读才算成功
                u.onerror = () => finish(false);
                synthesis.speak(u);
            } catch (e) {
                finish(false);
                return;
            }
            // 1.5s 内没开始朗读 → 视为「假支持」，回退在线
            setTimeout(() => {
                if (!done) {
                    lastErr = '系统语音无响应（可能缺少韩语语音）';
                    try { synthesis.cancel(); } catch (e) { /* 忽略 */ }
                    finish(false);
                }
            }, 1500);
        }).then((ok) => {
            if (ok) return true;
            return speakOnline(text);
        });
    }

    /**
     * 在线朗读：单元素快速串行（避免安卓双元素 play() 互斥 abort）
     * 引擎0先试，800ms 未出声或出错 → 切引擎1。
     * play().then() 也算成功（部分浏览器 onplaying 不触发但实际已出声）。
     * @returns {Promise<boolean>}
     */
    /**
     * 在线朗读：用常驻 <video> 直连百度 TTS 播放跨域音频（无需 CORS，国内可直连）。
     *
     * 历史坑（v64 修复）：早期是「双引擎」（百度 + 有道）自动切换，用 800ms 短超时判断
     * 「当前引擎不出声就切下一个」。现在只剩百度一个引擎，这个 800ms 超时反而成了真凶——
     * 平板上网络抖动 / 媒体解码偶尔 >800ms 未触发 onplaying，就会被直接判失败、且没有任何兜底，
     * 表现为「联网也很多导入词不响」（内置词走本地音频包所以都正常）。
     * 修复：
     *  1) 仅当存在「下一个引擎」时才用 800ms 快速切换；单引擎时耐心等待 onplaying/oncanplay；
     *  2) 额外把 oncanplay 也算成功信号（缓冲就绪即可播，避免漏判）；
     *  3) 单引擎失败时重试一次（网络抖动自愈），6s 总兜底。
     * @returns {Promise<boolean>}
     */
    function speakOnline(text) {
        const seq = ++onlineSeq;
        stopLocalSpeak();
        const cleaned = cleanTextForTTS(text);
        if (!cleaned) { lastErr = '文本为空'; return Promise.resolve(false); }
        const a = ensureAudioEl();
        if (!a) { lastErr = '浏览器不支持 audio'; return Promise.resolve(false); }

        return new Promise((resolve) => {
            let settled = false;
            let attempts = 0;
            const MAX_ATTEMPTS = 2;   // 同一引擎最多试 2 次（网络抖动自愈）

            const finish = (ok) => {
                if (settled) return;
                settled = true;
                resolve(ok);
            };

            const tryEngine = (idx) => {
                if (seq !== onlineSeq || settled) { finish(false); return; }
                if (idx >= ONLINE_TTS.length) { finish(false); return; }
                const eng = ONLINE_TTS[idx];
                let engineDone = false;

                const engineSettle = (ok, why) => {
                    if (engineDone || settled) return;
                    engineDone = true;
                    if (ok) {
                        finish(true);
                    } else {
                        lastErr = (eng.name || '引擎' + idx) + ': ' + (why || '失败');
                        try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) { /* 忽略 */ }
                        if (idx + 1 < ONLINE_TTS.length) {
                            tryEngine(idx + 1);            // 多引擎：切下一个
                        } else if (attempts < MAX_ATTEMPTS - 1) {
                            attempts++;                    // 单引擎：重试一次（网络抖动自愈）
                            setTimeout(() => { if (!settled && seq === onlineSeq) tryEngine(idx); }, 350);
                        } else {
                            finish(false);
                        }
                    }
                };

                a.onerror = () => engineSettle(false, '加载失败');
                a.onplaying = () => engineSettle(true);
                a.oncanplay = () => engineSettle(true);    // 缓冲就绪即视为可播（更宽容，避免漏判）
                a.onended = () => { if (onlineAudio === a) onlineAudio = null; };
                a.volume = 1;
                a.muted = false;
                a.src = eng.build(cleaned);
                a.load();

                const p = a.play();
                if (p && p.then) {
                    p.then(() => {
                        // play() 成功 → 给 onplaying/oncanplay 400ms 机会，否则直接算成功
                        // （部分安卓浏览器 onplaying 不触发但音频实际在播放）
                        if (!engineDone && !settled) {
                            setTimeout(() => {
                                if (!engineDone && !settled && seq === onlineSeq) engineSettle(true);
                            }, 400);
                        }
                    }).catch((e) => engineSettle(false, String(e && e.name || e)));
                }

                // 仅当存在下一个引擎时才用 800ms 短超时快速切换；
                // 单引擎时耐心等待（由下方 6s 总兜底收口），绝不轻易判失败。
                if (idx + 1 < ONLINE_TTS.length) {
                    setTimeout(() => { if (!engineDone) engineSettle(false, '超时'); }, 800);
                }
            };

            tryEngine(0);

            // 总兜底 6s：仍无声音才判定失败
            setTimeout(() => finish(false), 6000);
        });
    }

    /** 最近一次在线发音失败原因（诊断用） */
    function getLastError() { return lastErr; }

    /** 实测百度直连是否可播放：用隐藏 <video> 加载跨域媒体（无需 CORS 也能拿到 metadata）。
     *  成功（oncanplay/onloadedmetadata）即代表该词在线发音可用。 */
    function testBaiduPlayable(text) {
        return new Promise((resolve) => {
            const cleaned = cleanTextForTTS(text);
            if (!cleaned) { resolve({ ok: false, err: '文本无法清理为韩语' }); return; }
            const url = ONLINE_TTS[0].build(cleaned);
            let v = null;
            try {
                v = document.createElement('video');
                v.preload = 'auto';
                v.muted = false;
                // 屏幕外、非 display:none，规避个别浏览器对隐藏媒体的特殊处理
                v.style.position = 'fixed';
                v.style.left = '-9999px';
                v.style.width = '1px'; v.style.height = '1px'; v.style.opacity = '0.01';
            } catch (e) { resolve({ ok: false, err: '无法创建媒体元素' }); return; }
            let done = false;
            const finish = (ok, err) => {
                if (done) return; done = true;
                try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* 忽略 */ }
                resolve({ ok, err });
            };
            const to = setTimeout(() => finish(false, '超时（网络不可达/被拦截，或媒体解码慢）'), 6000);
            // 真正触发播放，最贴近实际发音路径（诊断在用户点击手势内，允许自动播放）
            v.oncanplay = () => { clearTimeout(to); finish(true); };
            v.onplaying = () => { clearTimeout(to); finish(true); };
            v.onerror = () => { clearTimeout(to); finish(false, '加载失败（可能被网络拦截）'); };
            v.src = url; v.load();
            try { const p = v.play(); if (p && p.then) p.catch(() => {}); } catch (e) { /* 忽略 */ }
        });
    }

    /** 发音环境诊断信息（供「我的」页一键诊断按钮展示） */
    function diagnose() {
        return {
            ua: navigator.userAgent || '',
            isMobile: isMobile(),
            mode: ttsMode,
            hasKoreanVoice: !!koreanVoice,
            voicesLoaded: voicesLoaded,
            synthesisSupported: ('speechSynthesis' in window),
            engineCount: ONLINE_TTS.length,
            engineNames: ONLINE_TTS.map(e => e.name)
        };
    }

    /**
     * 停止朗读
     */
    function stopSpeak() {
        stopLocalSpeak();
        stopOnlineSpeak();
    }

    function stopLocalSpeak() {
        if (synthesis) { try { synthesis.cancel(); } catch (e) { /* 忽略 */ } }
    }

    function stopOnlineSpeak() {
        onlineSeq++;
        if (audioEl) {
            try { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); } catch (e) { /* 忽略 */ }
        }
        onlineAudio = null;
    }

    // ===== 录音功能 =====
    let mediaRecorder = null;
    let audioChunks = [];
    let audioBlob = null;
    let audioUrl = null;
    let stream = null;

    /**
     * 检查是否支持语音合成
     */
    function isTTSSupported() {
        return ('speechSynthesis' in window) || ONLINE_TTS.length > 0;
    }

    /**
     * 检查是否支持录音
     */
    function isRecordingSupported() {
        return navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    }

    return {
        init,
        speak,
        stopSpeak,
        getMode,
        setMode,
        hasKoreanVoice,
        getLastError,
        cleanTextForTTS,
        diagnose,
        precacheImport,
        getProxy,
        setProxy,
        clearTtsCache: () => TtsCache.clearAll(),
        diagnoseImport: async (text) => {
            const t = (text || '').trim();
            const steps = [];
            steps.push({ name: '系统韩语语音', ok: !!(synthesis && koreanVoice), err: (synthesis && koreanVoice) ? '' : '无韩语语音包（用在线发音即可）' });
            const fn = await lookupKo(t);
            steps.push({ name: '本地音频包(ko_index)', ok: !!fn, err: fn ? '' : '未命中（非教材词，正常）' });
            const cu = TtsCache.getURL(t);
            steps.push({ name: '导入词音频缓存', ok: !!cu, err: cu ? '' : '未缓存（首次发音后 SW 会自动缓存）' });
            // 实测百度直连是否可播放（<video> 加载跨域媒体不需要 CORS）
            const play = await testBaiduPlayable(t);
            steps.push({ name: '在线发音(百度直连)', ok: play.ok, err: play.ok ? '' : (play.err || '无法播放') });
            return { text: t, steps, proxy: getProxy(), note: '百度直连即��发音路径，无需 CORS 代理' };
        },
        isTTSSupported,
        isRecordingSupported
    };
})();
