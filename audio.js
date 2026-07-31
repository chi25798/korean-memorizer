/**
 * audio.js - 语音合成（TTS）和录音功能
 * 
 * 使用 Web Speech API 进行韩语朗读
 * 使用 MediaRecorder API 进行录音
 */

const Audio = (() => {

    let synthesis = null;
    let koreanVoice = null;
    let voicesLoaded = false;

    // 初始化语音合成
    function init() {
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
        // 优先找韩语语音
        koreanVoice = voices.find(v => v.lang.startsWith('ko')) || null;
        voicesLoaded = true;
    }

    /**
     * 朗读韩语文本
     * @param {string} text - 要朗读的文本
     * @param {number} rate - 语速（0.5-2.0，默认1.0）
     */
    function speak(text, rate = 0.9) {
        if (!synthesis) {
            console.warn('语音合成不可用');
            return;
        }

        // 停止之前的朗读
        synthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ko-KR';
        utterance.rate = rate;
        utterance.pitch = 1.0;

        if (koreanVoice) {
            utterance.voice = koreanVoice;
        }

        synthesis.speak(utterance);
    }

    /**
     * 停止朗读
     */
    function stopSpeak() {
        if (synthesis) {
            synthesis.cancel();
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
        return 'speechSynthesis' in window;
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
        startRecording,
        stopRecording,
        playRecording,
        isTTSSupported,
        isRecordingSupported
    };
})();
