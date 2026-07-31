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

    // 在线韩语 TTS 引擎（按优先级尝试；国内网络友好，均无需 API key）
    const ONLINE_TTS = [
        { name: '有道', build: t => 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(t) + '&type=2' },
        { name: '百度', build: t => 'https://fanyi.baidu.com/gettts?lan=kor&text=' + encodeURIComponent(t) + '&spd=3&source=web' }
    ];

    // 移动端判断（Android / iOS / 平板）
    function isMobile() {
        return /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent || '');
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

    // 常驻隐藏 audio 元素池（每引擎一个）：安卓 WebView / 微信 X5 内核要求音频元素在 DOM 中才允许播放
    let audioPool = [];
    function ensurePool() {
        if (audioPool.length) return audioPool;
        try {
            audioPool = ONLINE_TTS.map(() => {
                const a = document.createElement('audio');
                a.preload = 'auto';
                a.style.display = 'none';
                a.setAttribute('playsinline', '');
                a.setAttribute('webkit-playsinline', '');
                (document.body || document.documentElement).appendChild(a);
                return a;
            });
        } catch (e) { /* 忽略 */ }
        return audioPool;
    }

    /**
     * 朗读韩语文本
     * @param {string} text - 要朗读的文本
     * @param {number} rate - 语速（0.5-2.0，默认0.9）
     * @returns {Promise<boolean>} 是否成功开始播放
     */
    function speak(text, rate = 0.9) {
        if (!text) return Promise.resolve(false);
        if (useLocalNow() && synthesis) {
            try {
                synthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = 'ko-KR';
                utterance.rate = rate;
                utterance.pitch = 1.0;
                if (koreanVoice) utterance.voice = koreanVoice;
                synthesis.speak(utterance);
                return Promise.resolve(true);
            } catch (e) {
                // 系统语音异常 → 回退在线
                return speakOnline(text);
            }
        }
        return speakOnline(text);
    }

    /**
     * 在线朗读：所有引擎并行请求，谁先真实出声（onplaying）用谁，其余立即停掉
     * 解决「某个引擎被浏览器拦截（如夸克 abort 有道）→ 串行等待切换」造成的延迟
     * @returns {Promise<boolean>}
     */
    function speakOnline(text) {
        const seq = ++onlineSeq;
        stopLocalSpeak();
        const pool = ensurePool();
        if (!pool.length) {
            lastErr = '浏览器不支持 audio 元素';
            return Promise.resolve(false);
        }
        return new Promise((resolve) => {
            let settled = false;
            let failures = 0;
            const elState = pool.map(() => ({ failed: false }));
            const finish = (ok) => { if (settled) return; settled = true; resolve(ok); };
            const noteFail = (idx, why) => {
                if (elState[idx].failed) return;
                elState[idx].failed = true;
                failures++;
                lastErr = ((ONLINE_TTS[idx] || {}).name || ('引擎' + idx)) + ': ' + (why || '失败');
                if (failures >= pool.length && !settled) finish(false);
            };
            pool.forEach((a, idx) => {
                const eng = ONLINE_TTS[idx];
                if (!eng) return;
                a.onerror = () => noteFail(idx, 'abort/加载失败');
                a.onplaying = () => {
                    if (settled) { try { a.pause(); } catch (e) { /* 忽略 */ } return; }
                    finish(true);
                    // 停掉其它引擎，避免重复出声
                    pool.forEach((o, j) => {
                        if (j !== idx) {
                            try { o.pause(); o.removeAttribute('src'); o.load(); } catch (e) { /* 忽略 */ }
                        }
                    });
                };
                a.onended = () => { if (onlineAudio === a) onlineAudio = null; };
                a.volume = 1;
                a.muted = false;
                a.src = eng.build(text);
                a.load();
                const p = a.play();
                if (p && p.catch) p.catch((e) => noteFail(idx, String(e && e.name || e)));
            });
            // 兜底：5 秒内无人出声 → 失败
            setTimeout(() => { if (!settled) finish(false); }, 5000);
        });
    }

    /** 最近一次在线发音失败原因（诊断用） */
    function getLastError() { return lastErr; }

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
        audioPool.forEach((a) => {
            try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) { /* 忽略 */ }
        });
        onlineAudio = null;
    }

    // ===== 录音功能 =====
    let mediaRecorder = null;
    let audioChunks = [];
    let audioBlob = null;
    let audioUrl = null;
    let stream = null;

    /**
     * 开始录音
     * @returns {Promise<boolean>} 是否成功开始
     */
    async function startRecording() {
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    audioChunks.push(e.data);
                }
            };

            mediaRecorder.start();
            return true;
        } catch (err) {
            console.error('录音启动失败:', err);
            return false;
        }
    }

    /**
     * 停止录音
     * @returns {Promise<string>} 录音的 URL
     */
    function stopRecording() {
        return new Promise((resolve) => {
            if (!mediaRecorder) {
                resolve(null);
                return;
            }

            mediaRecorder.onstop = () => {
                audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                if (audioUrl) {
                    URL.revokeObjectURL(audioUrl);
                }
                audioUrl = URL.createObjectURL(audioBlob);
                
                // 关闭麦克风
                if (stream) {
                    stream.getTracks().forEach(track => track.stop());
                }
                
                resolve(audioUrl);
            };

            mediaRecorder.stop();
        });
    }

    /**
     * 播放最近的录音
     */
    function playRecording() {
        if (audioUrl) {
            const audio = new window.Audio(audioUrl);
            audio.play();
        }
    }

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
        startRecording,
        stopRecording,
        playRecording,
        isTTSSupported,
        isRecordingSupported
    };
})();
