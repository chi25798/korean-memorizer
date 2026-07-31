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
        // auto：设备有韩语语音 → 系统；没有 → 在线（手机/平板常见）
        return hasKoreanVoice();
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
     * 在线朗读：依次尝试各引擎，某个引擎播放成功即返回
     * @returns {Promise<boolean>}
     */
    function speakOnline(text) {
        const seq = ++onlineSeq;
        stopLocalSpeak();
        return new Promise((resolve) => {
            const tryEngine = (i) => {
                if (seq !== onlineSeq) { resolve(false); return; }   // 已被新的朗读打断
                if (i >= ONLINE_TTS.length) { resolve(false); return; }
                const eng = ONLINE_TTS[i];
                let a = null;
                try { a = new Audio(); } catch (e) { /* 忽略 */ }
                if (!a) { tryEngine(i + 1); return; }
                onlineAudio = a;
                let settled = false;
                const finish = (ok) => {
                    if (settled) return;
                    settled = true;
                    resolve(ok);
                };
                const fail = () => {
                    if (settled) return;
                    settled = true;
                    try { a.pause(); a.src = ''; } catch (e) { /* 忽略 */ }
                    if (onlineAudio === a) onlineAudio = null;
                    tryEngine(i + 1);
                };
                a.addEventListener('error', fail, { once: true });
                a.addEventListener('ended', () => { if (onlineAudio === a) onlineAudio = null; }, { once: true });
                a.src = eng.build(text);
                const p = a.play();
                if (p && p.then) {
                    p.then(() => finish(true)).catch(fail);
                } else {
                    finish(true);
                }
                // 加载超时兜底（8 秒）
                setTimeout(() => { if (!settled) fail(); }, 8000);
            };
            tryEngine(0);
        });
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
        if (onlineAudio) {
            try { onlineAudio.pause(); onlineAudio.src = ''; } catch (e) { /* 忽略 */ }
            onlineAudio = null;
        }
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
        startRecording,
        stopRecording,
        playRecording,
        isTTSSupported,
        isRecordingSupported
    };
})();
