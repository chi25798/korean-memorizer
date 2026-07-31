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

    // 在线韩语 TTS 引擎（百度优先：短词/单字语法词也稳定；有道对短词常 500 作备用）
    const ONLINE_TTS = [
        { name: '百度', build: t => 'https://fanyi.baidu.com/gettts?lan=kor&text=' + encodeURIComponent(t) + '&spd=3&source=web' },
        { name: '有道', build: t => 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(t) + '&type=2' }
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

    // 常驻隐藏 audio 元素：安卓 WebView / 微信 X5 内核要求音频元素在 DOM 中才允许播放
    let audioEl = null;
    function ensureAudioEl() {
        if (audioEl && audioEl.isConnected) return audioEl;
        try {
            audioEl = document.createElement('audio');
            audioEl.preload = 'auto';
            audioEl.style.display = 'none';
            audioEl.setAttribute('playsinline', '');
            audioEl.setAttribute('webkit-playsinline', '');
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
     * 在线朗读：单元素快速串行（避免安卓双元素 play() 互斥 abort）
     * 引擎0先试，800ms 未出声或出错 → 切引擎1。
     * play().then() 也算成功（部分浏览器 onplaying 不触发但实际已出声）。
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
            let switchTimer = null;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                if (switchTimer) { clearTimeout(switchTimer); switchTimer = null; }
                resolve(ok);
            };

            const tryEngine = (idx) => {
                if (seq !== onlineSeq) { finish(false); return; }
                if (idx >= ONLINE_TTS.length) { finish(false); return; }
                const eng = ONLINE_TTS[idx];
                let engineDone = false;

                // 标记此引擎结束（成功或失败），阻止重复回调
                const engineSettle = (ok, why) => {
                    if (engineDone || settled) return;
                    engineDone = true;
                    if (switchTimer) { clearTimeout(switchTimer); switchTimer = null; }
                    if (ok) {
                        finish(true);
                    } else {
                        lastErr = (eng.name || '引擎' + idx) + ': ' + (why || '失败');
                        try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) { /* 忽略 */ }
                        tryEngine(idx + 1);   // 快速切换下一个引擎
                    }
                };

                a.onerror = () => engineSettle(false, '加载失败');
                a.onplaying = () => engineSettle(true);
                a.onended = () => { if (onlineAudio === a) onlineAudio = null; };
                a.volume = 1;
                a.muted = false;
                a.src = eng.build(cleaned);
                a.load();

                const p = a.play();
                if (p && p.then) {
                    p.then(() => {
                        // play() 成功 → 给 onplaying 400ms 机会，否则直接算成功
                        // （部分安卓浏览器 onplaying 不触发但音频实际在播放）
                        if (!engineDone && !settled) {
                            setTimeout(() => {
                                if (!engineDone && !settled && seq === onlineSeq) {
                                    engineSettle(true);
                                }
                            }, 400);
                        }
                    }).catch((e) => engineSettle(false, String(e && e.name || e)));
                }

                // 800ms 未出声 → 切换下一个引擎（不等 8s 超时）
                switchTimer = setTimeout(() => {
                    if (!engineDone) engineSettle(false, '超时');
                }, 800);
            };

            tryEngine(0);

            // 总兜底 6s
            setTimeout(() => finish(false), 6000);
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
        cleanTextForTTS,
        startRecording,
        stopRecording,
        playRecording,
        isTTSSupported,
        isRecordingSupported
    };
})();
