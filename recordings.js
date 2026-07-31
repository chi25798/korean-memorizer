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

    // ===== 播放元素（用 video 绕过夸克限制） =====
    let playEl = null;
    let lastUrl = null;

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

    /** 播放指定词的录音 */
    async function play(wordId) {
        const blob = await get(wordId);
        if (!blob) return false;
        const el = ensurePlayEl();
        if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
        lastUrl = URL.createObjectURL(blob);
        el.src = lastUrl;
        el.load();
        try {
            await el.play();
            return true;
        } catch (e) {
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
        if (!isSupported()) return false;
        try {
            activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // 选一个浏览器支持的 mimeType
            const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
                : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
                : '';
            mediaRecorder = mime ? new MediaRecorder(activeStream, { mimeType: mime }) : new MediaRecorder(activeStream);
            chunks = [];
            mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
            mediaRecorder.start();
            return true;
        } catch (e) {
            if (activeStream) { activeStream.getTracks().forEach(t => t.stop()); activeStream = null; }
            return false;
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
        init, save, get, hasCached, remove, clear, count, play,
        isSupported, start, stopAndSave, abort, isRecording
    };
})();
