/**
 * recordings.js - 用户录音存储与播放模块
 *
 * 用 IndexedDB 持久化存储每个单词的录音（Blob），按 wordId 索引。
 * 内存缓存 Set 记录哪些 wordId 有录音（同步查询，不阻断 speak 的手势栈）。
 * 播放用 <video> 元素（与 TTS 一致，绕过夸克对隐藏 audio 的静音限制）。
 *
 * 录音后，Audio.speak(text, rate, wordId) 会优先播放用户录音，无录音才走 TTS。
 */
const Recordings = (() => {

    const DB_NAME = 'korean-memorizer-recordings';
    const STORE = 'recordings';
    const DB_VERSION = 1;
    let db = null;
    let ready = false;

    // 内存缓存：有录音的 wordId 集合（同步查询，避免 speak 异步等待 IndexedDB）
    const cache = new Set();

    function init() {
        return new Promise((resolve) => {
            if (!('indexedDB' in window)) { resolve(false); return; }
            try {
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = (e) => {
                    const d = e.target.result;
                    if (!d.objectStoreNames.contains(STORE)) {
                        d.createObjectStore(STORE);
                    }
                };
                req.onsuccess = (e) => {
                    db = e.target.result;
                    // 加载所有 key 到内存缓存
                    try {
                        const tx = db.transaction(STORE, 'readonly').objectStore(STORE);
                        const kr = tx.getAllKeys();
                        kr.onsuccess = () => {
                            (kr.result || []).forEach(k => cache.add(k));
                            ready = true;
                            resolve(true);
                        };
                        kr.onerror = () => { ready = true; resolve(true); };
                    } catch (err) { ready = true; resolve(true); }
                };
                req.onerror = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    }

    function _store(mode) {
        return db.transaction(STORE, mode).objectStore(STORE);
    }

    /** 保存录音 */
    function save(wordId, blob) {
        return new Promise((resolve) => {
            if (!db) { resolve(false); return; }
            try {
                const r = _store('readwrite').put(blob, wordId);
                r.onsuccess = () => { cache.add(wordId); resolve(true); };
                r.onerror = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    }

    /** 获取录音 Blob */
    function get(wordId) {
        return new Promise((resolve) => {
            if (!db) { resolve(null); return; }
            try {
                const r = _store('readonly').get(wordId);
                r.onsuccess = () => resolve(r.result || null);
                r.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        });
    }

    /** 同步查询：是否有录音（查内存缓存，不碰 IndexedDB） */
    function hasCached(wordId) {
        return cache.has(wordId);
    }

    /** 删除单个录音 */
    function remove(wordId) {
        return new Promise((resolve) => {
            if (!db) { resolve(false); return; }
            try {
                const r = _store('readwrite').delete(wordId);
                r.onsuccess = () => { cache.delete(wordId); resolve(true); };
                r.onerror = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    }

    /** 清空所有录音 */
    function clear() {
        return new Promise((resolve) => {
            if (!db) { resolve(false); return; }
            try {
                const r = _store('readwrite').clear();
                r.onsuccess = () => { cache.clear(); resolve(true); };
                r.onerror = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    }

    /** 录音数量 */
    function count() {
        return cache.size;
    }

    /** 列出全部录音的 wordId（用于「我的」页逐条管理） */
    function listAll() {
        return new Promise((resolve) => {
            if (!db) { resolve([]); return; }
            try {
                const r = _store('readonly').getAllKeys();
                r.onsuccess = () => resolve(r.result || []);
                r.onerror = () => resolve([]);
            } catch (e) { resolve([]); }
        });
    }

    // ===== 播放（三级回退：video → audio → Web Audio API） =====
    // 录音是 MediaRecorder 生成的 webm/mp4，夸克 video 元素可能不支持（TTS 的 MP3 能播）
    let playEl = null;        // video 元素
    let recAudioEl = null;    // audio 元素（本地 blob 一般不受夸克静音限制）
    let audioCtx = null;      // Web Audio 上下文
    let playLastUrl = null;

    function ensurePlayEl() {
        if (playEl && playEl.isConnected) return playEl;
        playEl = document.createElement('video');
        playEl.preload = 'auto';
        playEl.style.position = 'fixed';
        playEl.style.left = '-9999px';
        playEl.style.width = '2px';
        playEl.style.height = '2px';
        playEl.style.opacity = '0.01';
        playEl.style.pointerEvents = 'none';
        playEl.style.zIndex = '-1';
        playEl.setAttribute('playsinline', '');
        playEl.setAttribute('webkit-playsinline', '');
        playEl.setAttribute('x5-playsinline', '');
        (document.body || document.documentElement).appendChild(playEl);
        return playEl;
    }

    function ensureRecAudioEl() {
        if (recAudioEl && recAudioEl.isConnected) return recAudioEl;
        recAudioEl = document.createElement('audio');
        recAudioEl.preload = 'auto';
        recAudioEl.setAttribute('playsinline', '');
        recAudioEl.setAttribute('webkit-playsinline', '');
        recAudioEl.setAttribute('x5-playsinline', '');
        (document.body || document.documentElement).appendChild(recAudioEl);
        return recAudioEl;
    }

    /** 播放指定词的录音（Web Audio 优先，直接输出扬声器，夸克无法静音；失败再回退 video/audio） */
    async function play(wordId) {
        const blob = await get(wordId);
        if (!blob) return false;
        if (playLastUrl) { try { URL.revokeObjectURL(playLastUrl); } catch (e) { /* 忽略 */ } }
        playLastUrl = URL.createObjectURL(blob);

        // 方法1：Web Audio API 解码播放（绕过媒体元素解码器，最可靠）
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') await audioCtx.resume();
            const buf = await blob.arrayBuffer();
            const decoded = await audioCtx.decodeAudioData(buf);
            const srcNode = audioCtx.createBufferSource();
            srcNode.buffer = decoded;
            srcNode.connect(audioCtx.destination);
            srcNode.start();
            return true;
        } catch (e1) { /* 继续尝试 */ }

        // 方法2：video 元素（TTS 同款方案）
        try {
            const el = ensurePlayEl();
            el.src = playLastUrl;
            el.load();
            await el.play();
            return true;
        } catch (e2) { /* 继续尝试 */ }

        // 方法3：audio 元素（本地 blob 通常不受夸克静音限制）
        try {
            const a = ensureRecAudioEl();
            a.src = playLastUrl;
            a.load();
            await a.play();
            return true;
        } catch (e3) {
            return false;
        }
    }

    // ===== 录音功能（MediaRecorder） =====
    let mediaRecorder = null;
    let chunks = [];
    let activeStream = null;

    function isSupported() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
    }

    async function start() {
        if (!isSupported()) return { ok: false, why: 'unsupported' };
        try {
            activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // 选一个浏览器支持的 mimeType（mp4/AAC 优先，播放端兼容性最好）
            const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
                : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
                : '';
            mediaRecorder = mime ? new MediaRecorder(activeStream, { mimeType: mime }) : new MediaRecorder(activeStream);
            chunks = [];
            mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
            mediaRecorder.start();
            return { ok: true };
        } catch (e) {
            if (activeStream) { activeStream.getTracks().forEach(t => t.stop()); activeStream = null; }
            return { ok: false, why: (e && e.name) || 'unknown' };
        }
    }

    /** 停止录音并保存到 wordId，返回是否成功 */
    function stopAndSave(wordId) {
        return new Promise((resolve) => {
            if (!mediaRecorder) { resolve(false); return; }
            mediaRecorder.onstop = async () => {
                try {
                    const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
                    if (activeStream) { activeStream.getTracks().forEach(t => t.stop()); activeStream = null; }
                    if (blob.size < 200) { resolve(false); return; }  // 太小，可能没录到
                    const ok = await save(wordId, blob);
                    resolve(ok);
                } catch (e) { resolve(false); }
            };
            mediaRecorder.stop();
        });
    }

    /** 中止录音（不保存） */
    function abort() {
        try {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        } catch (e) { /* 忽略 */ }
        if (activeStream) { activeStream.getTracks().forEach(t => t.stop()); activeStream = null; }
        mediaRecorder = null;
        chunks = [];
    }

    function isRecording() {
        return !!(mediaRecorder && mediaRecorder.state === 'recording');
    }

    return {
        init, save, get, hasCached, remove, clear, count, listAll, play,
        isSupported, start, stopAndSave, abort, isRecording
    };
})();

// 关键：const 声明的全局变量不会挂到 window 上，
// 其他脚本用 window.Recordings 检查会永远 undefined → 这里显式挂载
if (typeof window !== 'undefined') {
    window.Recordings = Recordings;
}
