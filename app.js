// ===== 安全元素访问 =====
// 早期版本删除了「背课文 / 生词本 / 管理 / 每日一句」等模块的 HTML，
// 但部分旧逻辑仍在引用这些元素。直接访问会抛 TypeError 并中断后续代码
// （曾导致「我的」页按钮全部失效）。这里对已不存在的元素返回一个游离的
// 存根节点，让旧逻辑静默空转。
const _DEAD_EL_STUB = document.createElement('div');
function $el(id) {
    return document.getElementById(id) || _DEAD_EL_STUB;
}

// ===== 单词编辑覆盖层兜底 =====
// 正常情况下由 profiles.js 定义并挂到 window.WordEdits。
// 但若 profiles.js 因缓存/加载异常未生效，这里兜底保证编辑功能一定可用，
// 杜绝「点了没反应 / 编辑功能未就绪」。profiles.js 先加载，若已定义则沿用其版本。
if (typeof window.WordEdits === 'undefined') {
    window.WordEdits = {
        map: {},
        _key() {
            try {
                if (window.Profiles && typeof window.Profiles.prefix === 'function' && window.Profiles.currentId) {
                    return window.Profiles.prefix(window.Profiles.currentId) + 'word_overrides';
                }
            } catch (e) {}
            return 'km_word_overrides';
        },
        load() { try { this.map = JSON.parse(localStorage.getItem(this._key()) || '{}'); } catch (e) { this.map = {}; } },
        save() { localStorage.setItem(this._key(), JSON.stringify(this.map)); },
        get(id) { return this.map[id] || null; },
        set(id, fields) { this.map[id] = Object.assign({}, fields, { _edited: true }); this.save(); },
        remove(id) { delete this.map[id]; this.save(); },
        has(id) { return !!this.map[id]; }
    };
}

/**
 * app.js - 韩语背诵 App 主逻辑
 */

// ===== 一次性数据修复：畸形 word id 迁移（v25）=====
// 第一册录入时有 52 条单词 id 被多插了一段 "1"（w-1-1-{课}-{序}），
// 规范格式应为 w-{册}-{课}-{序}。data.js 已修正，这里把浏览器本地
// 按旧 id 存的「学习进度」和「编辑覆盖层」同步改名，避免进度失配丢失。
// 只跑一次（打标记），且只改能确定匹配旧格式的 key，其余原样保留。
const LEGACY_WORD_ID = /^w-1-1-(\d+)-(\d+)$/;

function _fixLegacyWordId(id) {
    if (typeof id !== 'string') return id;
    const m = LEGACY_WORD_ID.exec(id);
    return m ? ('w-1-' + m[1] + '-' + m[2]) : id;
}

function migrateLegacyWordIds() {
    const FLAG = 'km_wordid_fix_v25';
    try {
        if (localStorage.getItem(FLAG)) return;

        let changed = 0;
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));

        keys.forEach(key => {
            if (!key) return;
            const raw = localStorage.getItem(key);
            if (!raw) return;

            // 1) 进度数组：km_words / km_<用户>_words / km_custom_words
            if (/words$/.test(key)) {
                try {
                    const arr = JSON.parse(raw);
                    if (!Array.isArray(arr)) return;
                    let hit = false;
                    arr.forEach(item => {
                        if (item && typeof item === 'object') {
                            const nid = _fixLegacyWordId(item.id);
                            if (nid !== item.id) { item.id = nid; hit = true; changed++; }
                        }
                    });
                    if (hit) localStorage.setItem(key, JSON.stringify(arr));
                } catch (e) { /* 该键不是合法 JSON，跳过 */ }
                return;
            }

            // 2) 编辑覆盖层：km_word_overrides / km_<用户>_word_overrides（key 即 wordId）
            if (/word_overrides$/.test(key)) {
                try {
                    const obj = JSON.parse(raw);
                    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
                    const out = {};
                    let hit = false;
                    Object.keys(obj).forEach(k => {
                        const nk = _fixLegacyWordId(k);
                        if (nk !== k) { hit = true; changed++; }
                        out[nk] = obj[k];
                    });
                    if (hit) localStorage.setItem(key, JSON.stringify(out));
                } catch (e) { /* 跳过 */ }
            }
        });

        localStorage.setItem(FLAG, '1');
        if (changed) console.log('[迁移] 已修正畸形 word id 引用 ' + changed + ' 处');
    } catch (e) {
        // 迁移失败不能阻断启动：最坏情况只是这批词进度重置
        console.warn('[迁移] word id 迁移失败，已跳过', e);
    }
}

// ===== 数据管理 =====
const DB = {
    words: [],
    stats: { learnedDates: [], streak: 0, lastStudyDate: null },

    load() {
        const version = localStorage.getItem(STORAGE_KEYS.dataVersion);
        // v2→v3 首次：以内置第一册为权威、忽略旧的示例/空数据
        // v3 及以后：内置内容（含修正）为权威，叠加本地学习进度，升级不再清空进度
        const fromOld = (!version || parseInt(version) < 3);

        const savedWords = localStorage.getItem(STORAGE_KEYS.words);

        if (fromOld) {
            // 旧版本 / 首次打开：直接以内置数据初始化
            this.words = allWords().map(w => SRS.initWord(w));
        } else {
            // 升级：内容用内置（修正后的韩文/中文生效），进度字段（box/评分等）保留本地，用户自定义条目保留
            this.words = this._mergeItems(savedWords, allWords(), 'word');
        }

        // 给单词分配 lessonId
        this._assignLessonIds();

        // 套用当前用户的单词编辑覆盖层（按用户隔离，不污染共享词库）
        this._applyWordEdits();

        // 写入当前数据版本号
        localStorage.setItem(STORAGE_KEYS.dataVersion, String(DATA_VERSION));

        this.save();

        // 加载统计（独立键，跨版本保留）
        const savedStats = localStorage.getItem(STORAGE_KEYS.stats);
        if (savedStats) {
            this.stats = JSON.parse(savedStats);
        }
    },

    _assignLessonIds() {
        const map = {};
        allLessons().forEach(l => l.wordIds.forEach(wid => { map[wid] = l.id; }));
        this.words.forEach(w => {
            if (!w.lessonId && map[w.id]) w.lessonId = map[w.id];
        });
    },

    // 套用当前用户的单词编辑覆盖层：克隆被修改的词（不污染共享的 BUILTIN_WORDS / Custom.words）
    _applyWordEdits() {
        if (typeof window.WordEdits === 'undefined') return;
        this.words = this.words.map(w => {
            const ov = window.WordEdits.get(w.id);
            if (!ov) return w;
            return Object.assign({}, w, {
                korean: ov.korean !== undefined ? ov.korean : w.korean,
                pronunciation: ov.pronunciation !== undefined ? ov.pronunciation : w.pronunciation,
                chinese: ov.chinese !== undefined ? ov.chinese : w.chinese,
                exampleKo: ov.exampleKo !== undefined ? ov.exampleKo : w.exampleKo,
                exampleZh: ov.exampleZh !== undefined ? ov.exampleZh : w.exampleZh,
                _edited: true
            });
        });
    },

    // 合并内置条目与本地进度：
    // 内容以内置为准（修正后的韩文/中文生效），进度字段（status/box/nextReview/lastReview/reviewCount/inWordbook）保留本地，
    // 不在内置中的用户自定义条目（id 以 'u' 开头）一并保留
    _mergeItems(savedRaw, builtin, kind) {
        let saved = [];
        if (savedRaw) {
            try { saved = JSON.parse(savedRaw); } catch (e) { saved = []; }
        }
        const savedMap = new Map(saved.map(x => [x.id, x]));
        const progressFields = ['status', 'box', 'nextReview', 'lastReview', 'reviewCount', 'inWordbook'];
        const result = builtin.map(b => {
            const base = SRS.initWord(b);
            const s = savedMap.get(b.id);
            if (s) {
                progressFields.forEach(f => { if (s[f] !== undefined) base[f] = s[f]; });
            }
            return base;
        });
        // 追加用户自定义条目（不在内置中）
        saved.forEach(s => {
            if (!builtin.find(b => b.id === s.id)) {
                result.push(s);
            }
        });
        return result;
    },

    save() {
        // 被当前用户编辑过的词，写回时回退成「共享库原始内容 + 学习进度」，避免覆盖被存进共享库
        // （否则其他用户/还原会受影响）。未编辑的词原样保存，行为与旧版一致。
        const progressFields = ['status', 'box', 'nextReview', 'lastReview', 'reviewCount', 'inWordbook'];
        const canonical = new Map(allWords().map(w => [w.id, w]));
        const outWords = this.words.map(w => {
            if (!w._edited) return w;
            const c = canonical.get(w.id) || w;
            const o = Object.assign({}, c);
            progressFields.forEach(f => { if (w[f] !== undefined) o[f] = w[f]; });
            return o;
        });
        localStorage.setItem(STORAGE_KEYS.words, JSON.stringify(outWords));
        localStorage.setItem(STORAGE_KEYS.stats, JSON.stringify(this.stats));
    },

    addWord(wordData) {
        const newWord = SRS.initWord({
            ...wordData,
            id: 'u' + Date.now()
        });
        this.words.push(newWord);
        this.save();
        return newWord;
    },

    resetProgress() {
        this.words = SRS.resetAll(this.words);
        this.stats = { learnedDates: [], streak: 0, lastStudyDate: null };
        this.save();
    },

    // 清空所有单词（保留设置、计划、每日一句与连续学习天数记录）
    clearAllWordsAndTexts() {
        this.words = [];
        this.save();
    },

    recordStudy() {
        const today = new Date().toISOString().split('T')[0];
        if (!this.stats.learnedDates.includes(today)) {
            this.stats.learnedDates.push(today);
            // 更新连续天数
            const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
            if (this.stats.lastStudyDate === yesterday || this.stats.lastStudyDate === today) {
                this.stats.streak++;
            } else {
                this.stats.streak = 1;
            }
            this.stats.lastStudyDate = today;
            this.save();
        }
    },

    getLearnedCountByDate(date) {
        return this.words.filter(w => {
            if (!w.lastReview) return false;
            const reviewDate = new Date(w.lastReview).toISOString().split('T')[0];
            return reviewDate === date;
        }).length;
    },

    getLessons() {
        return allLessons().map(lesson => {
            const words = this.words.filter(w => w.lessonId === lesson.id);
            const wordStats = SRS.getStats(words);
            return {
                ...lesson,
                words,
                wordStats
            };
        });
    },

    getWordsByLesson(lessonId) {
        return this.words.filter(w => w.lessonId === lessonId);
    },

    // ===== 计划数据 =====
    plan: null,

    loadPlan() {
        const saved = localStorage.getItem(STORAGE_KEYS.plan);
        if (saved) {
            this.plan = JSON.parse(saved);
        } else {
            this.plan = { enabled: true, dailyWords: 10, dailyTexts: 1, log: {} };
        }
    },

    savePlan() {
        localStorage.setItem(STORAGE_KEYS.plan, JSON.stringify(this.plan));
    },

    _todayKey() {
        // 用本地日期（非 UTC），避免跨时区（如 GMT+8）在凌晨把"今天"算错一天
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    },

    logPlanActivity(type) {
        if (!this.plan || !this.plan.enabled) return;
        const key = this._todayKey();
        if (!this.plan.log[key]) {
            this.plan.log[key] = { newWords: 0, newTexts: 0 };
        }
        if (type === 'word') {
            this.plan.log[key].newWords++;
        } else if (type === 'text') {
            this.plan.log[key].newTexts++;
        }
        this.savePlan();
    },

    getTodayPlan() {
        const key = this._todayKey();
        const log = (this.plan && this.plan.log[key]) || { newWords: 0, newTexts: 0 };
        return {
            wordDone: log.newWords,
            wordTarget: this.plan ? this.plan.dailyWords : 0,
            textDone: log.newTexts,
            textTarget: this.plan ? this.plan.dailyTexts : 0,
            enabled: this.plan ? this.plan.enabled : false
        };
    },

    getPlanHistory(days) {
        const result = [];
        const today = new Date();
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const p = (n) => String(n).padStart(2, '0');
            const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
            const log = (this.plan && this.plan.log[key]) || { newWords: 0, newTexts: 0 };
            const wordTarget = this.plan ? this.plan.dailyWords : 0;
            const textTarget = this.plan ? this.plan.dailyTexts : 0;
            const wordComplete = wordTarget > 0 && log.newWords >= wordTarget;
            const textComplete = textTarget > 0 && log.newTexts >= textTarget;
            result.push({
                date: key,
                dayLabel: ['日','一','二','三','四','五','六'][d.getDay()],
                newWords: log.newWords,
                newTexts: log.newTexts,
                wordTarget,
                textTarget,
                wordComplete,
                textComplete,
                allComplete: wordComplete && textComplete
            });
        }
        return result;
    }
};

// ===== Toast 提示 =====
function toast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast ' + type;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 2500);
}

// ===== 页面导航 =====
function navigateTo(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + pageId).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${pageId}"]`).classList.add('active');

    // 页面初始化
    switch (pageId) {
        case 'learn': initLearnPage(); break;
        case 'review': initReviewPage(); break;
        case 'plan': initPlanPage(); break;
        case 'vocab': initVocabPage(); break;
        case 'import': initImportPage(); break;
        case 'me': initMePage(); break;
    }
}

// ===== 首页 =====
function renderHome() {
    const stats = SRS.getStats(DB.words);
    $el('stat-total').textContent = stats.total;
    $el('stat-learned').textContent = stats.learned;

    const _sd = document.getElementById('streak-days');
    if (_sd) _sd.textContent = DB.stats.streak || 0;

    // 双核心入口的统计信息
    $el('word-stats-text').textContent = `${stats.learned} / ${stats.total} 已学`;
    const wordReviewBadge = $el('word-review-badge');
    wordReviewBadge.textContent = `${stats.reviewDue} 待复习`;
    if (stats.reviewDue > 0) {
        wordReviewBadge.style.background = 'rgba(255, 107, 157, 0.2)';
        wordReviewBadge.style.color = 'var(--pink-deep)';
    }

    const totalReviewDue = stats.reviewDue;
    const reviewDueText = totalReviewDue > 0
        ? `${totalReviewDue} 项待复习`
        : '暂无待复习';
    $el('review-due-text').textContent = reviewDueText;

    const wordbookCount = DB.words.filter(w => w.inWordbook).length;
    $el('wordbook-due-text').textContent = `${wordbookCount} 个生词`;

    // 渲染7天柱状图
    const chartContainer = $el('chart-bars');
    chartContainer.innerHTML = '';
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        const count = DB.getLearnedCountByDate(dateStr);
        const maxCount = Math.max(1, ...Array.from({ length: 7 }, (_, j) => {
            const d = new Date(today);
            d.setDate(d.getDate() - (6 - j));
            return DB.getLearnedCountByDate(d.toISOString().split('T')[0]);
        }));
        const heightPercent = (count / maxCount) * 100;
        const dayLabel = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];

        const barItem = document.createElement('div');
        barItem.className = 'chart-bar-item';
        barItem.innerHTML = `
            <div class="chart-bar" style="height: ${Math.max(4, heightPercent)}%">
                ${count > 0 ? `<span class="chart-bar-count">${count}</span>` : ''}
            </div>
            <span class="chart-bar-label">${dayLabel}</span>
        `;
        chartContainer.appendChild(barItem);
    }

    // 渲染课程进度
    renderLessonProgress();

    // 每日一句
    renderDailySentence();
}

function renderLessonProgress() {
    const lessons = DB.getLessons();
    const listEl = $el('lesson-progress-list');
    listEl.innerHTML = '';

    if (lessons.length === 0) {
        listEl.innerHTML = '<div class="empty-hint">📭 还没有课程，添加单词和课文后将自动生成进度。</div>';
        return;
    }

    lessons.forEach(lesson => {
        const ws = lesson.wordStats;
        const wordPercent = ws.total > 0 ? (ws.learned / ws.total * 100) : 0;

        const item = document.createElement('div');
        item.className = 'lesson-progress-item';
        item.innerHTML = `
            <div class="lp-title">${lesson.title}</div>
            <div class="lp-dual-bar">
                <div class="lp-dual-row">
                    <span class="lp-label">词</span>
                    <div class="lp-bar"><div class="lp-bar-fill word-fill" style="width:${wordPercent}%"></div></div>
                </div>
            </div>
            <div class="lp-stats">
                词 ${ws.learned}/${ws.total}
            </div>
        `;
        listEl.appendChild(item);
    });
}

// ===== 每日一句 =====
let dailySentenceIndex = 0;

function getDailySentenceIndex() {
    // 根据一年中的第几天选择句子
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const diff = now - start;
    const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
    return dayOfYear % DAILY_SENTENCES.length;
}

function renderDailySentence() {
    if (dailySentenceIndex === 0) {
        dailySentenceIndex = getDailySentenceIndex();
    }
    const sentence = DAILY_SENTENCES[dailySentenceIndex];
    $el('daily-ko').textContent = sentence.ko;
    $el('daily-zh').textContent = sentence.zh;
}

function dailySentenceSpeak() {
    const ko = $el('daily-ko').textContent;
    if (ko) Audio.speak(ko, 0.9);
}

function dailySentenceRefresh() {
    dailySentenceIndex = (dailySentenceIndex + 1) % DAILY_SENTENCES.length;
    renderDailySentence();
}

// ===== 计划页 =====
function initPlanPage() {
    renderPlanToday();
    renderPlanSettings();
    renderPlanHistory();
    renderPlanDetail();
}

function renderPlanToday() {
    const plan = DB.getTodayPlan();
    const today = new Date();
    const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日 星期${['日','一','二','三','四','五','六'][today.getDay()]}`;
    document.getElementById('plan-today-date').textContent = dateStr;

    document.getElementById('plan-word-done').textContent = plan.wordDone;
    document.getElementById('plan-word-target').textContent = plan.wordTarget;

    const wordPct = plan.wordTarget > 0 ? Math.min(100, plan.wordDone / plan.wordTarget * 100) : 0;
    document.getElementById('plan-word-bar').style.width = wordPct + '%';

    const pctEl = document.getElementById('plan-word-pct');
    if (pctEl) pctEl.textContent = Math.round(wordPct) + '%';
    const hintEl = document.getElementById('plan-word-hint');
    if (hintEl) {
        if (!plan.enabled) {
            hintEl.textContent = '计划追踪已关闭，开启后开始统计';
            hintEl.className = 'ptc-hint status-off';
        } else if (plan.wordTarget - plan.wordDone <= 0) {
            hintEl.textContent = '✅ 已达成今日单词目标，太棒了！';
            hintEl.className = 'ptc-hint status-done';
        } else {
            hintEl.textContent = `还差 ${plan.wordTarget - plan.wordDone} 个新词就完成今日目标`;
            hintEl.className = 'ptc-hint status-pending';
        }
    }

    const statusEl = document.getElementById('plan-today-status');
    if (!plan.enabled) {
        statusEl.textContent = '计划追踪已关闭';
        statusEl.className = 'plan-today-status status-off';
    } else if (wordPct >= 100) {
        statusEl.textContent = '🎉 今日目标已全部完成！太棒了！';
        statusEl.className = 'plan-today-status status-done';
    } else if (wordPct > 0) {
        statusEl.textContent = '💪 部分目标已完成，继续加油！';
        statusEl.className = 'plan-today-status status-partial';
    } else {
        statusEl.textContent = '今日未开卷，宜取一篇而读。';
        statusEl.className = 'plan-today-status status-pending';
    }
}

function renderPlanSettings() {
    document.getElementById('plan-word-setting').textContent = DB.plan.dailyWords;
    document.getElementById('plan-enabled').checked = DB.plan.enabled;
}

function handlePlanStep(type, dir) {
    if (type === 'word') {
        DB.plan.dailyWords = Math.max(1, Math.min(50, DB.plan.dailyWords + dir));
    } else {
        DB.plan.dailyTexts = Math.max(0, Math.min(10, DB.plan.dailyTexts + dir));
    }
    DB.savePlan();
    renderPlanSettings();
    renderPlanToday();
    renderPlanHistory();
}

function handlePlanToggle() {
    DB.plan.enabled = document.getElementById('plan-enabled').checked;
    DB.savePlan();
    renderPlanToday();
}

function renderPlanHistory() {
    const history = DB.getPlanHistory(7);
    const gridEl = document.getElementById('plan-history-grid');
    gridEl.innerHTML = '';

    history.forEach(day => {
        const item = document.createElement('div');
        item.className = 'ph-day' + (day.allComplete ? ' ph-day-done' : '');

        const wordPct = day.wordTarget > 0 ? Math.min(100, day.newWords / day.wordTarget * 100) : 0;
        const textPct = day.textTarget > 0 ? Math.min(100, day.newTexts / day.wordTarget * 100) : 0;

        item.innerHTML = `
            <div class="ph-day-label">周${day.dayLabel}</div>
            <div class="ph-day-date">${day.date.slice(5)}</div>
            <div class="ph-day-stats">
                <div class="ph-stat ${day.wordComplete ? 'ph-stat-done' : ''}">
                    <span class="ph-stat-icon">词</span>
                    <span class="ph-stat-val">${day.newWords}/${day.wordTarget}</span>
                </div>
                <div class="ph-stat ${day.textComplete ? 'ph-stat-done' : ''}">
                    <span class="ph-stat-icon">📝</span>
                    <span class="ph-stat-val">${day.newTexts}/${day.textTarget}</span>
                </div>
            </div>
            <div class="ph-day-check">${day.allComplete ? '✅' : (day.newWords + day.newTexts > 0 ? '⭕' : '⬜')}</div>
        `;
        gridEl.appendChild(item);
    });
}

function renderPlanDetail() {
    const lessons = DB.getLessons();
    const container = document.getElementById('plan-detail-rows');
    container.innerHTML = '';

    if (lessons.length === 0) {
        container.innerHTML = '<div class="empty-hint">📭 还没有课程，添加单词和课文后即可查看进度详情。</div>';
        return;
    }

    lessons.forEach(lesson => {
        const ws = lesson.wordStats;
        const wordPct = ws.total > 0 ? (ws.learned / ws.total * 100) : 0;

        const row = document.createElement('div');
        row.className = 'pdr-item';
        row.innerHTML = `
            <div class="pdr-title">${lesson.title}</div>
            <div class="pdr-bars">
                <div class="pdr-bar-row">
                    <span class="pdr-bar-label">词</span>
                    <div class="pdr-bar"><div class="pdr-bar-fill word-fill" style="width:${wordPct}%"></div></div>
                    <span class="pdr-bar-num">${ws.learned}/${ws.total}</span>
                </div>
            </div>
        `;
        container.appendChild(row);
    });
}

// ===== 背单词页 =====
let learnQueue = [];
let learnModeFor = [];          // 与 learnQueue 平行：每个单词使用哪种练习模式
let learnIndex = 0;
let currentLearnLesson = null;
let pendingLearnLesson = null;
let learnSelectedModes = ['ko2zh'];
let learnRunStyle = 'mixed';
let learnScored = new Map();    // 本次会话已计入 SRS 的单词：id -> 已生效的最差评分

// 背单词练习模式
const LEARN_MODES = {
    ko2zh:     { label: '韩语→汉语', hint: '看韩语，想中文' },
    zh2ko:     { label: '汉语→韩语', hint: '看中文，选韩语' },
    listen2zh: { label: '听力→汉语', hint: '听发音，想中文' }
};

function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function loadLearnModePref() {
    try {
        const raw = localStorage.getItem('km_learn_modes');
        if (raw) {
            const o = JSON.parse(raw);
            if (Array.isArray(o.modes) && o.modes.length) learnSelectedModes = o.modes.filter(m => LEARN_MODES[m]);
            if (o.style === 'mixed' || o.style === 'separate') learnRunStyle = o.style;
        }
    } catch (e) {}
}

function saveLearnModePref() {
    try {
        localStorage.setItem('km_learn_modes', JSON.stringify({ modes: learnSelectedModes, style: learnRunStyle }));
    } catch (e) {}
}

function initLearnPage() {
    loadLearnModePref();
    document.getElementById('learn-lesson-list').classList.remove('hidden');
    document.getElementById('learn-container').classList.add('hidden');
    document.getElementById('learn-empty').classList.add('hidden');
    document.getElementById('learn-back-btn').classList.add('hidden');
    document.getElementById('learn-page-title').textContent = '背单词';
    renderLearnLessonList();
}

function renderLearnLessonList() {
    const lessons = DB.getLessons();
    const listEl = document.getElementById('learn-lesson-list');
    listEl.innerHTML = '';

    if (lessons.length === 0) {
        listEl.innerHTML = '<div class="empty-hint">📭 还没有单词，去「导入」页添加或导入吧！</div>';
        return;
    }

    // 按「册 / 书名」分组（与词库一致的层级），每册可折叠
    const map = {};
    lessons.forEach(lesson => {
        const g = lessonGroupInfo(lesson);
        if (!map[g.key]) map[g.key] = { key: g.key, label: g.label, sort: g.sort, isNum: g.isNum, lessons: [] };
        map[g.key].lessons.push(lesson);
    });
    const arr = Object.keys(map).map(k => map[k]);
    arr.sort((a, b) => {
        if (a.isNum && b.isNum) return a.sort - b.sort;
        if (a.isNum) return -1;
        if (b.isNum) return 1;
        return String(a.sort).localeCompare(String(b.sort), 'zh');
    });

    arr.forEach(g => {
        const volBlock = document.createElement('div');
        volBlock.className = 'learn-volume-block';
        const volHead = document.createElement('div');
        volHead.className = 'learn-volume-head';
        volHead.setAttribute('data-learn-vol', g.key);
        volHead.innerHTML = `<span class="vcaret">▾</span><span class="vvt-label">${escapeHtml(g.label)}</span><span class="vvol-count">${g.lessons.length} 课</span>`;
        volBlock.appendChild(volHead);
        const volBody = document.createElement('div');
        volBody.className = 'learn-volume-body';

        g.lessons.forEach(lesson => {
            const ws = lesson.wordStats;
            let badge = '';
            if (ws.reviewDue > 0) {
                badge = `<span class="lesson-badge lesson-badge-due">${ws.reviewDue} 词待复习</span>`;
            } else if (ws.learned === ws.total && ws.total > 0) {
                badge = `<span class="lesson-badge lesson-badge-done">已掌握</span>`;
            } else if (ws.learned > 0) {
                badge = `<span class="lesson-badge lesson-badge-learning">学习中</span>`;
            } else {
                badge = `<span class="lesson-badge lesson-badge-new">未开始</span>`;
            }

            const progressPercent = ws.total > 0 ? (ws.learned / ws.total * 100) : 0;

            const card = document.createElement('div');
            card.className = 'lesson-card';
            card.innerHTML = `
                <div class="lesson-card-header">
                    <div class="lesson-card-title">${lesson.title}</div>
                    ${badge}
                </div>
                <div class="lesson-card-info">
                    <span>共 ${ws.total} 词</span>
                    <span>✅ ${ws.learned} 已学</span>
                    <span>待温 ${ws.reviewDue}</span>
                </div>
                <div class="lesson-progress-bar">
                    <div class="lesson-progress-fill" style="width: ${progressPercent}%"></div>
                </div>
                ${ws.learned > 0 ? `<button class="lesson-replay" data-replay="${lesson.id}">🔁 重练这课</button>` : ''}
            `;
            card.addEventListener('click', () => openLearnModePicker(lesson.id));
            const rp = card.querySelector('[data-replay]');
            if (rp) rp.addEventListener('click', (e) => replayLesson(lesson.id, e));
            volBody.appendChild(card);
        });

        volBlock.appendChild(volBody);
        listEl.appendChild(volBlock);
    });

    // 册折叠
    listEl.querySelectorAll('[data-learn-vol]').forEach(el => {
        el.addEventListener('click', () => {
            const body = el.parentElement.querySelector('.learn-volume-body');
            const caret = el.querySelector('.vcaret');
            if (body) { const h = body.classList.toggle('collapsed'); if (caret) caret.textContent = h ? '▸' : '▾'; }
        });
    });
}

function startLearnLesson(lessonId) {
    currentLearnLesson = lessonId;
    const lesson = allLessons().find(l => l.id === lessonId);
    const lessonWords = DB.getWordsByLesson(lessonId);

    // 队列 = 本课全部单词，可自由左右翻看；顺序：待复习 → 没学过 → 已学过
    const dueWords = SRS.getDueWords(lessonWords);
    const dueIds = new Set(dueWords.map(w => w.id));
    const newWords = lessonWords.filter(w => w.status === 'new' && !dueIds.has(w.id));
    const newIds = new Set(newWords.map(w => w.id));
    const restWords = lessonWords.filter(w => !dueIds.has(w.id) && !newIds.has(w.id));
    const q = [...dueWords, ...newWords, ...restWords];

    // 按所选模式构建队列
    // 分离：每种模式各跑一轮（队列×模式数）
    // 混合：每张卡片随机用一种已选模式（一轮过完）
    let modes = learnSelectedModes.filter(m => LEARN_MODES[m]);
    if (!modes.length) modes = ['ko2zh'];

    learnQueue = [];
    learnModeFor = [];
    if (learnRunStyle === 'separate') {
        // 分离：只用一种模式，每个词只出现一次
        const only = modes[0];
        q.forEach(w => { learnQueue.push(w); learnModeFor.push(only); });
    } else {
        // 混合：勾几种就跑几轮，每个词按每种模式各出现一次；
        // 每轮内模式轮转错开，同一个词的两次出现相隔整整一轮，避免刚看完答案又考
        modes.forEach((_, r) => {
            q.forEach((w, i) => {
                learnQueue.push(w);
                learnModeFor.push(modes[(i + r) % modes.length]);
            });
        });
    }
    learnScored = new Map();
    learnIndex = 0;

    document.getElementById('learn-lesson-list').classList.add('hidden');
    document.getElementById('learn-back-btn').classList.remove('hidden');
    document.getElementById('learn-page-title').textContent = `${lesson.title}`;

    if (learnQueue.length === 0) {
        document.getElementById('learn-container').classList.add('hidden');
        document.getElementById('learn-empty').classList.remove('hidden');
        return;
    }

    document.getElementById('learn-container').classList.remove('hidden');
    document.getElementById('learn-empty').classList.add('hidden');
    renderCardDots();
    showLearnCard();
}

function backToLearnLessons() {
    initLearnPage();
}

const STATUS_LABEL = {
    new: '未学',
    learning: '学习中',
    review: '复习中',
    mastered: '已掌握'
};

function showLearnCard() {
    if (learnQueue.length === 0) return;
    // 翻到范围外时循环，方便反复浏览
    if (learnIndex < 0) learnIndex = learnQueue.length - 1;
    if (learnIndex >= learnQueue.length) learnIndex = 0;

    const word = learnQueue[learnIndex];
    const mode = learnModeFor[learnIndex];

    document.getElementById('learn-count').textContent = `第 ${learnIndex + 1} / ${learnQueue.length} 词`;

    const tag = document.getElementById('card-status');
    if (tag) {
        const st = word.status || 'new';
        tag.textContent = STATUS_LABEL[st] || st;
        tag.className = 'card-status-tag status-' + st;
    }

    // 模式徽章
    const badge = document.getElementById('card-mode-badge');
    if (badge) {
        badge.textContent = LEARN_MODES[mode].label;
        badge.className = 'card-mode-badge mode-' + mode;
    }

    // 基础赋值
    document.getElementById('card-korean').textContent = word.korean;
    document.getElementById('card-pronunciation').textContent = word.pronunciation || '';
    document.getElementById('card-chinese').textContent = word.chinese;
    document.getElementById('card-example-ko').textContent = word.exampleKo || '';
    document.getElementById('card-example-zh').textContent = word.exampleZh || '';
    document.getElementById('card-chinese').classList.remove('as-prompt');

    // 先全部盖住，再由各模式决定显隐
    ['card-korean', 'card-pronunciation', 'card-chinese', 'card-example',
     'card-actions', 'card-options', 'btn-flip', 'card-listen-hint', 'card-prompt-label']
        .forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });

    // 翻页动画
    const card = document.getElementById('word-card');
    if (card) {
        card.classList.remove('card-slide');
        void card.offsetWidth;
        card.classList.add('card-slide');
    }
    updateCardDots();

    if (mode === 'zh2ko') renderZh2Ko(word);
    else if (mode === 'listen2zh') renderListen2Zh(word);
    else renderKo2Zh(word);

    // 🔊 汉语→韩语模式下先禁音：未选对前朗读会把隐藏的韩语答案报出来
    const speakBtn = document.getElementById('card-speak');
    if (speakBtn) {
        const lock = (mode === 'zh2ko');
        speakBtn.disabled = lock;
        speakBtn.classList.toggle('is-disabled', lock);
        speakBtn.title = lock ? '选出正确答案后可听发音' : '朗读';
    }
}

// 模式①：韩语 → 汉语（默认）
function renderKo2Zh(word) {
    document.getElementById('card-korean').classList.remove('hidden');
    document.getElementById('card-pronunciation').classList.remove('hidden');
    const flip = document.getElementById('btn-flip');
    flip.classList.remove('hidden');
    flip.textContent = '点击显示中文';
}

// 模式②：听力 → 汉语（听发音，想中文）
async function renderListen2Zh(word) {
    document.getElementById('card-listen-hint').classList.remove('hidden');
    const flip = document.getElementById('btn-flip');
    flip.classList.remove('hidden');
    flip.textContent = '🔊 已播放，点击显示中文';
    if (flip.dataset) delete flip.dataset.pendingSpeak;
    // 自动朗读（短延迟确保语音引擎就绪；手机/平板若被系统拦截则改为点击播放）
    setTimeout(async () => {
        const ok = await Audio.speak(word.korean, 0.9, word.id);
        if (!ok && flip.dataset) {
            flip.textContent = '🔊 点击播放发音';
            flip.dataset.pendingSpeak = word.korean;
        }
    }, 280);
}

// 模式③：汉语 → 韩语（看中文，从选项里选）
function renderZh2Ko(word) {
    document.getElementById('card-chinese').classList.remove('hidden');
    document.getElementById('card-chinese').classList.add('as-prompt');
    document.getElementById('card-prompt-label').classList.remove('hidden');
    document.getElementById('card-options').classList.remove('hidden');
    buildZh2KoOptions(word);
}

function buildZh2KoOptions(word) {
    const box = document.getElementById('card-options');
    // 干扰项：优先同课其他词，不足时补全局
    let pool = DB.getWordsByLesson(currentLearnLesson)
        .filter(w => w.korean && w.korean !== word.korean);
    if (pool.length < 3) {
        pool = pool.concat(allWords().filter(w => w.korean && w.korean !== word.korean
            && !pool.some(p => p.korean === w.korean)));
    }
    const distract = shuffle(pool.map(w => w.korean)).slice(0, 3);
    const opts = shuffle([word.korean, ...distract]);
    box.innerHTML = opts.map(ko =>
        `<button class="opt-btn" data-ko="${escapeHtml(ko)}">${escapeHtml(ko)}</button>`
    ).join('');
    box.querySelectorAll('.opt-btn').forEach(btn => {
        btn.addEventListener('click', () => onZh2KoPick(btn, word));
    });
}

function onZh2KoPick(btn, word) {
    if (btn.dataset.ko === word.korean) {
        btn.classList.add('opt-correct');
        revealZh2Ko(word);
    } else {
        btn.classList.add('opt-wrong');
        btn.disabled = true;
    }
}

function revealZh2Ko(word) {
    document.getElementById('card-korean').classList.remove('hidden');
    document.getElementById('card-pronunciation').classList.remove('hidden');
    document.getElementById('card-example').classList.remove('hidden');
    document.getElementById('card-actions').classList.remove('hidden');
    document.getElementById('card-options').classList.add('hidden');
    document.getElementById('card-prompt-label').classList.add('hidden');
    // 选对后开放 🔊，可听正确答案发音
    const sb = document.getElementById('card-speak');
    if (sb) { sb.disabled = false; sb.classList.remove('is-disabled'); sb.title = '朗读'; }
}

function renderCardDots() {
    const box = document.getElementById('card-dots');
    if (!box) return;
    box.innerHTML = learnQueue.map((w, i) => {
        const m = LEARN_MODES[learnModeFor[i]];
        const t = w.korean + (m ? ' · ' + m.label : '');
        return `<span class="card-dot" data-dot="${i}" title="${escapeHtml(t)}"></span>`;
    }).join('');
    box.querySelectorAll('[data-dot]').forEach(el => {
        el.addEventListener('click', () => {
            learnIndex = parseInt(el.dataset.dot);
            showLearnCard();
        });
    });
    updateCardDots();
}

function updateCardDots() {
    const box = document.getElementById('card-dots');
    if (!box) return;
    box.querySelectorAll('.card-dot').forEach((el, i) => {
        const w = learnQueue[i];
        el.className = 'card-dot dot-' + ((w && w.status) || 'new') + (i === learnIndex ? ' active' : '');
    });
}

function cardPrev() {
    learnIndex--;
    showLearnCard();
}

function cardNext() {
    learnIndex++;
    showLearnCard();
}

function flipCard() {
    // 听力模式：自动播放失败时（手机/平板），点击翻面先补播发音
    const flipBtn = document.getElementById('btn-flip');
    if (flipBtn && flipBtn.dataset && flipBtn.dataset.pendingSpeak) {
        const t = flipBtn.dataset.pendingSpeak;
        delete flipBtn.dataset.pendingSpeak;
        Audio.speak(t);
    }
    document.getElementById('card-chinese').classList.remove('hidden');
    document.getElementById('card-example').classList.remove('hidden');
    document.getElementById('card-actions').classList.remove('hidden');
    document.getElementById('btn-flip').classList.add('hidden');
    // 听力模式：翻面后也显示韩文 + 收起听音提示
    if (learnModeFor[learnIndex] === 'listen2zh') {
        document.getElementById('card-korean').classList.remove('hidden');
        document.getElementById('card-pronunciation').classList.remove('hidden');
        const hint = document.getElementById('card-listen-hint');
        if (hint) hint.classList.add('hidden');
    }
}

function rateWord(rate) {
    const word = learnQueue[learnIndex];
    const wasNew = word.status === 'new';

    // 混合模式下同一个词会出现多次：只有第一次评分计入艾宾浩斯，
    // 之后除非评得更差（说明其实没记住，把 box 拉回来），否则只当练习、不重复升级
    const prev = learnScored.has(word.id) ? learnScored.get(word.id) : null;
    if (prev === null || rate < prev) {
        SRS.review(word, rate);
        learnScored.set(word.id, prev === null ? rate : Math.min(prev, rate));
        if (wasNew) DB.logPlanActivity('word');
        DB.save();
    }
    DB.recordStudy();

    // 最后一张评分完 → 本课完成
    if (learnIndex >= learnQueue.length - 1) {
        updateCardDots();
        const remain = learnQueue.filter(w => w.status === 'new').length;
        if (remain === 0) {
            toast('这课的单词都过了一遍啦！🎉', 'success');
        }
        learnIndex = 0;
        showLearnCard();
        return;
    }
    learnIndex++;
    showLearnCard();
}

// ===== 背单词：模式选择弹窗 =====
function openLearnModePicker(lessonId) {
    pendingLearnLesson = lessonId;
    const overlay = document.getElementById('learn-mode-overlay');
    overlay.querySelectorAll('input[data-mode]').forEach(cb => {
        cb.checked = learnSelectedModes.includes(cb.dataset.mode);
    });
    const radio = overlay.querySelector('input[name="learn-run"][value="' + learnRunStyle + '"]');
    if (radio) radio.checked = true;
    syncLearnModePicker();
    overlay.classList.remove('hidden');
}

// 分离 = 只能选一种模式；混合 = 可多选。同时刷新提示条
function syncLearnModePicker(changed) {
    const overlay = document.getElementById('learn-mode-overlay');
    if (!overlay) return;
    const boxes = [...overlay.querySelectorAll('input[data-mode]')];
    if (!boxes.length) return;
    const styleRadio = overlay.querySelector('input[name="learn-run"]:checked');
    const style = styleRadio ? styleRadio.value : 'mixed';

    if (style === 'separate') {
        // 单选：保留刚点的那个；若是取消勾选导致一个都不剩，则回填第一个
        const keep = (changed && changed.dataset.mode && changed.checked)
            ? changed
            : (boxes.find(b => b.checked) || boxes[0]);
        boxes.forEach(b => { b.checked = (b === keep); });
    } else if (!boxes.some(b => b.checked)) {
        boxes[0].checked = true;
    }

    const list = overlay.querySelector('.mode-list');
    if (list) list.classList.toggle('single-pick', style === 'separate');

    const picked = boxes.filter(b => b.checked).length;
    const n = pendingLearnLesson ? DB.getWordsByLesson(pendingLearnLesson).length : 0;
    const tip = document.getElementById('learn-mode-tip');
    if (tip) {
        tip.textContent = (style === 'separate')
            ? `分离：只用 1 种模式，每个词 1 次，共 ${n} 张卡`
            : `混合：已选 ${picked} 种，每个词各来 ${picked} 次，共 ${n * picked} 张卡`;
    }
}

function closeLearnModePicker() {
    const overlay = document.getElementById('learn-mode-overlay');
    if (overlay) overlay.classList.add('hidden');
}

function learnModeStart() {
    const overlay = document.getElementById('learn-mode-overlay');
    const radio = overlay.querySelector('input[name="learn-run"]:checked');
    learnRunStyle = radio ? radio.value : 'mixed';
    let modes = [...overlay.querySelectorAll('input[data-mode]:checked')].map(cb => cb.dataset.mode);
    if (modes.length === 0) modes = ['ko2zh'];
    // 分离模式只允许一种，兜底截断
    if (learnRunStyle === 'separate') modes = [modes[0]];
    learnSelectedModes = modes;
    saveLearnModePref();
    const lessonId = pendingLearnLesson;
    closeLearnModePicker();
    startLearnLesson(lessonId);
}

// ===== 复习页 =====
let flashQueue = [];
let flashIndex = 0;
let spellQueue = [];
let spellIndex = 0;
let spellMode = 'input';                 // 'input' = 输入法模式；'canvas' = 手写板自评模式
let spellPromptMode = 'both';            // 拼写提示方式：'audio'=听发音 / 'text'=看中文 / 'both'=两者
let spellCanvas = null, spellCtx = null, spellDrawing = false;
let spellStrokes = [];                    // 已完成的笔画（每笔 = [{x,y}...]，CSS 像素坐标）
let spellCurrentStroke = null;            // 正在书写的当前笔

function initReviewPage() {
    const dueWords = SRS.getDueWords(DB.words);

    document.getElementById('flash-count').textContent = `${dueWords.length} 词待复习`;

    // 拼写复习：填充课程下拉（全部已学 + 各课）
    const sel = document.getElementById('spell-lesson');
    if (sel) {
        let html = '<option value="all">全部已学单词</option>';
        DB.getLessons().forEach(l => {
            const learned = l.words.filter(w => w.status !== 'new' && w.status !== 'mastered').length;
            html += `<option value="${escapeHtml(l.id)}">${escapeHtml(l.title)}（${learned} 已学）</option>`;
        });
        sel.innerHTML = html;
        sel.onchange = updateSpellCount;
        // 点下拉框不要冒泡到卡片（否则会直接开始复习）
        sel.onclick = (e) => { if (e) e.stopPropagation(); };
    }
    updateSpellCount();

    // 读取并同步拼写提示方式（持久化到 localStorage）
    const savedPrompt = localStorage.getItem('km_spell_prompt');
    if (savedPrompt === 'audio' || savedPrompt === 'text' || savedPrompt === 'both') {
        spellPromptMode = savedPrompt;
    }
    document.querySelectorAll('.spell-prompt-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.prompt === spellPromptMode);
    });

    // 显示模式选择，隐藏练习界面
    document.querySelector('.review-modes').classList.remove('hidden');
    document.getElementById('flash-session').classList.add('hidden');
    document.getElementById('spell-session').classList.add('hidden');
}

// 根据所选课程更新「可拼写」计数
function updateSpellCount() {
    const sel = document.getElementById('spell-lesson');
    let count;
    if (!sel || sel.value === 'all') {
        count = DB.words.filter(w => w.status !== 'new' && w.status !== 'mastered').length;
    } else {
        count = DB.getWordsByLesson(sel.value).filter(w => w.status !== 'new' && w.status !== 'mastered').length;
    }
    const el = document.getElementById('spell-count');
    if (el) el.textContent = `${count} 词可拼写`;
}

// --- 课文复习 ---
function backToReviewModes() {
    initReviewPage();
}

// --- 闪过复习 ---
function startFlashReview() {
    flashQueue = SRS.getDueWords(DB.words);
    if (flashQueue.length === 0) {
        toast('没有待复习的单词 🎉');
        return;
    }

    // 如果不到10个，补充已学过的词
    if (flashQueue.length < 10) {
        const extra = DB.words
            .filter(w => w.status !== 'new' && w.status !== 'mastered' && !flashQueue.includes(w))
            .slice(0, 10 - flashQueue.length);
        flashQueue = [...flashQueue, ...extra];
    }

    flashIndex = 0;
    document.querySelector('.review-modes').classList.add('hidden');
    document.getElementById('flash-session').classList.remove('hidden');
    showFlashCard();
}

function showFlashCard() {
    if (flashIndex >= flashQueue.length) {
        toast('闪过复习完成！🎉', 'success');
        initReviewPage();
        return;
    }

    const word = flashQueue[flashIndex];
    document.getElementById('flash-progress').textContent = `${flashIndex + 1} / ${flashQueue.length}`;
    document.getElementById('flash-korean').textContent = word.korean;
    document.getElementById('flash-pronunciation').textContent = word.pronunciation || '';
    document.getElementById('flash-chinese').textContent = word.chinese;
    document.getElementById('flash-example').textContent = word.exampleKo ? `${word.exampleKo} - ${word.exampleZh}` : '';

    document.getElementById('flash-chinese').classList.add('hidden');
    document.getElementById('flash-example').classList.add('hidden');
    document.getElementById('flash-flip').classList.remove('hidden');
    document.getElementById('flash-flip').textContent = '点击翻转';
}

function flipFlashCard() {
    document.getElementById('flash-chinese').classList.remove('hidden');
    document.getElementById('flash-example').classList.remove('hidden');
    document.getElementById('flash-flip').classList.add('hidden');
}

function rateFlashWord(rate) {
    const word = flashQueue[flashIndex];
    SRS.review(word, rate);
    DB.save();
    flashIndex++;
    showFlashCard();
}

// --- 拼写复习 ---
function startSpellReview() {
    const sel = document.getElementById('spell-lesson');
    let pool;
    if (!sel || sel.value === 'all') {
        pool = DB.words.filter(w => w.status !== 'new' && w.status !== 'mastered');
    } else {
        pool = DB.getWordsByLesson(sel.value).filter(w => w.status !== 'new' && w.status !== 'mastered');
    }
    if (pool.length === 0) {
        toast(sel && sel.value !== 'all' ? '这一课还没有已学单词，先去背一下吧' : '请先学习一些单词再来进行拼写复习');
        return;
    }

    // 打乱顺序，最多 20 个
    spellQueue = pool.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(20, pool.length));
    spellIndex = 0;

    document.querySelector('.review-modes').classList.add('hidden');
    document.getElementById('spell-session').classList.remove('hidden');
    showSpellCard();
}

function showSpellCard() {
    if (spellIndex >= spellQueue.length) {
        toast('拼写复习完成！🎉', 'success');
        initReviewPage();
        return;
    }

    const word = spellQueue[spellIndex];
    document.getElementById('spell-progress').textContent = `${spellIndex + 1} / ${spellQueue.length}`;
    document.getElementById('spell-chinese').textContent = word.chinese;
    document.getElementById('spell-input').value = '';
    document.getElementById('spell-input').focus();
    applySpellPrompt(word);   // 按用户选择的提示方式显示中文/播放发音

    // 两种模式共用：先重置结果 / 自评区
    document.getElementById('spell-result').classList.add('hidden');
    document.getElementById('spell-self-rate').classList.add('hidden');
    document.getElementById('spell-next').classList.add('hidden');
    document.getElementById('spell-correct').innerHTML = '';
    document.getElementById('spell-your').innerHTML = '';

    if (spellMode === 'canvas') {
        // 手写板模式：隐藏输入法，显示画布并清空
        document.getElementById('spell-submit').classList.add('hidden');
        document.getElementById('spell-input-area').classList.add('hidden');
        document.getElementById('spell-canvas-area').classList.remove('hidden');
        document.getElementById('spell-reveal').classList.remove('hidden');
        document.getElementById('spell-clear').classList.remove('hidden');
        document.getElementById('spell-undo').classList.remove('hidden');
        resizeSpellCanvas();
        resetSpellCanvas();
    } else {
        // 输入法模式
        document.getElementById('spell-submit').classList.remove('hidden');
        document.getElementById('spell-input-area').classList.remove('hidden');
        document.getElementById('spell-canvas-area').classList.add('hidden');
    }
}

// 按用户选择的提示方式显示中文 / 播放发音
function applySpellPrompt(word) {
    if (!word) return;
    const zh = document.getElementById('spell-chinese');
    const sp = document.getElementById('spell-speak');
    if (spellPromptMode === 'text') {
        // 看中文：隐藏听音按钮
        zh.classList.remove('hidden');
        sp.classList.add('hidden');
    } else if (spellPromptMode === 'audio') {
        // 听发音：隐藏中文，自动朗读
        zh.classList.add('hidden');
        sp.classList.remove('hidden');
        Audio.speak(word.korean, 0.9, word.id);
    } else {
        // 两者都有：中文 + 听音按钮
        zh.classList.remove('hidden');
        sp.classList.remove('hidden');
    }
}

function submitSpell() {
    const word = spellQueue[spellIndex];
    const input = document.getElementById('spell-input').value.trim();
    // 韩文有 NFC(组合 한) / NFD(分解 한) 两种编码，肉眼相同但 === 判不等。
    // iPad 随手写、部分安卓手写输入法会输出 NFD，不归一化会把写对的判成错。
    const normKo = (s) => (s || '').normalize('NFC').replace(/\s/g, '');
    const isCorrect = normKo(input) === normKo(word.korean);

    document.getElementById('spell-correct').innerHTML = `<span class="label">正确答案：</span>${word.korean}`;
    const yourEl = document.getElementById('spell-your');
    yourEl.className = 'spell-your ' + (isCorrect ? 'correct' : 'wrong');
    yourEl.innerHTML = `<span class="label">你的答案：</span>${input || '（空）'} ${isCorrect ? '✅' : '❌'}`;

    document.getElementById('spell-result').classList.remove('hidden');
    document.getElementById('spell-next').classList.remove('hidden');
    document.getElementById('spell-submit').classList.add('hidden');

    // 朗读正确答案
    Audio.speak(word.korean, 0.9, word.id);
}

function nextSpell() {
    spellIndex++;
    showSpellCard();
}

// ===== 手写板（画布）自评模式 =====
function setupSpellCanvas() {
    spellCanvas = document.getElementById('spell-canvas');
    if (!spellCanvas) return;
    spellCtx = spellCanvas.getContext('2d');

    // 坐标映射：用比例法，彻底消除 body zoom(1.1) / dpr 带来的位移
    const getPos = (e) => {
        const r = spellCanvas.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width * spellCanvas.width;
        const y = (e.clientY - r.top) / r.height * spellCanvas.height;
        return { x, y };
    };
    const down = (e) => {
        e.preventDefault();
        try { spellCanvas.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
        spellDrawing = true;
        spellCurrentStroke = [];
        spellCtx.beginPath();
        const p = getPos(e);
        spellCurrentStroke.push(p);
        spellCtx.moveTo(p.x, p.y);
    };
    const move = (e) => {
        if (!spellDrawing) return;
        e.preventDefault();
        // 用 getCoalescedEvents 抓回系统合并掉的中间点，笔迹更顺滑、无延迟感
        const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [e];
        for (const ev of evs) {
            const p = getPos(ev);
            spellCurrentStroke.push(p);
            spellCtx.lineTo(p.x, p.y);
            spellCtx.stroke();
        }
    };
    const up = (e) => {
        if (!spellDrawing) return;
        spellDrawing = false;
        try { spellCanvas.releasePointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
        if (spellCurrentStroke && spellCurrentStroke.length) {
            spellStrokes.push(spellCurrentStroke);
        }
        spellCurrentStroke = null;
        updateUndoBtn();
    };

    spellCanvas.addEventListener('pointerdown', down, { passive: false });
    spellCanvas.addEventListener('pointermove', move, { passive: false });
    spellCanvas.addEventListener('pointerup', up);
    spellCanvas.addEventListener('pointercancel', up);
    window.addEventListener('pointerup', up);

    document.getElementById('spell-clear').addEventListener('click', clearSpellCanvas);
    document.getElementById('spell-undo').addEventListener('click', undoSpellCanvas);
    document.getElementById('spell-reveal').addEventListener('click', revealCanvasAnswer);
    document.querySelectorAll('.btn-self-rate').forEach(b => {
        b.addEventListener('click', () => { selfRateSpell(parseInt(b.dataset.selfRate, 10)); });
    });
}

function applyStrokeStyle() {
    if (!spellCtx || !spellCanvas) return;
    const dpr = spellCanvas._dpr || 1;
    spellCtx.lineWidth = 3.5 * dpr;
    spellCtx.lineCap = 'round';
    spellCtx.lineJoin = 'round';
    spellCtx.strokeStyle = '#2b2b2b';
}

function redrawSpellCanvas() {
    if (!spellCtx) return;
    spellCtx.clearRect(0, 0, spellCanvas.width, spellCanvas.height);
    applyStrokeStyle();
    for (const stroke of spellStrokes) {
        if (!stroke.length) continue;
        spellCtx.beginPath();
        spellCtx.moveTo(stroke[0].x, stroke[0].y);
        for (let i = 1; i < stroke.length; i++) {
            spellCtx.lineTo(stroke[i].x, stroke[i].y);
        }
        spellCtx.stroke();
    }
}

function undoSpellCanvas() {
    if (!spellStrokes.length) return;
    spellStrokes.pop();
    redrawSpellCanvas();
    updateUndoBtn();
}

function updateUndoBtn() {
    const btn = $el('spell-undo');
    if (btn) btn.disabled = (spellStrokes.length === 0);
}

function resetSpellCanvas() {
    spellStrokes = [];
    spellCurrentStroke = null;
    clearSpellCanvas();
    updateUndoBtn();
}

function resizeSpellCanvas() {
    if (!spellCanvas || !spellCtx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = spellCanvas.clientWidth || 320;
    const h = spellCanvas.clientHeight || 220;
    if (w < 2 || h < 2) return; // 尚未显示（隐藏态 clientWidth=0），跳过，等 showSpellCard 再调
    spellCanvas.width = Math.round(w * dpr);
    spellCanvas.height = Math.round(h * dpr);
    spellCanvas._dpr = dpr;
    // 直接用内部像素坐标，配合 getPos 的比例映射，彻底规避 zoom/dpr 位移
    spellCtx.setTransform(1, 0, 0, 1, 0, 0);
    applyStrokeStyle();
}

function clearSpellCanvas() {
    if (!spellCtx) return;
    spellStrokes = [];
    spellCurrentStroke = null;
    spellCtx.clearRect(0, 0, spellCanvas.width, spellCanvas.height);
    updateUndoBtn();
}

function revealCanvasAnswer() {
    const word = spellQueue[spellIndex];
    if (!word) return;
    document.getElementById('spell-correct').innerHTML = `<span class="label">正确答案：</span>${word.korean}`;
    document.getElementById('spell-result').classList.remove('hidden');
    document.getElementById('spell-reveal').classList.add('hidden');
    document.getElementById('spell-clear').classList.add('hidden');
    document.getElementById('spell-undo').classList.add('hidden');
    document.getElementById('spell-self-rate').classList.remove('hidden');
    Audio.speak(word.korean, 0.9, word.id);
}

function selfRateSpell(rate) {
    const word = spellQueue[spellIndex];
    if (!word) return;
    const yourEl = document.getElementById('spell-your');
    if (rate >= 2) {
        yourEl.className = 'spell-your correct';
        yourEl.innerHTML = '<span class="label">自评：</span>写对了 ✓';
    } else {
        yourEl.className = 'spell-your wrong';
        yourEl.innerHTML = '<span class="label">自评：</span>写错了 ✗';
    }
    // 与「输入法」拼写模式保持一致：拼写练习不写回 SRS 记忆曲线，仅作自我对照
    document.getElementById('spell-self-rate').classList.add('hidden');
    document.getElementById('spell-next').classList.remove('hidden');
}

function setSpellMode(mode) {
    spellMode = mode;
    document.querySelectorAll('.spell-mode-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.spellMode === mode);
    });
    showSpellCard();
}

// ===== 生词本页 =====
function renderWordbook() {
    const wordbookWords = DB.words.filter(w => w.inWordbook);
    const listEl = $el('wordbook-list');
    const emptyEl = $el('wordbook-empty');

    $el('wordbook-count').textContent = `${wordbookWords.length} 个生词`;

    if (wordbookWords.length === 0) {
        listEl.innerHTML = '';
        emptyEl.classList.remove('hidden');
        return;
    }

    emptyEl.classList.add('hidden');
    listEl.innerHTML = '';
    wordbookWords.forEach(word => {
        const item = document.createElement('div');
        item.className = 'wordbook-item';
        item.innerHTML = `
            <div class="wb-korean">${word.korean}</div>
            <div class="wb-pronunciation">${word.pronunciation || ''}</div>
            <div class="wb-chinese">${word.chinese}</div>
            ${word.exampleKo ? `<div class="wb-example">${word.exampleKo}<br>${word.exampleZh}</div>` : ''}
            <div class="wb-actions">
                <button class="wb-btn" data-action="speak" data-word="${word.korean}">🔊 朗读</button>
                <button class="wb-btn wb-btn-remove" data-action="remove" data-id="${word.id}">✕ 移除</button>
            </div>
        `;
        listEl.appendChild(item);
    });

    // 绑定事件
    listEl.querySelectorAll('.wb-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const action = this.dataset.action;
            if (action === 'speak') {
                Audio.speak(this.dataset.word);
            } else if (action === 'remove') {
                const word = DB.words.find(w => w.id === this.dataset.id);
                if (word) {
                    word.inWordbook = false;
                    DB.save();
                    renderWordbook();
                    toast('已从生词本移除');
                }
            }
        });
    });
}

// ===== 管理页 =====
function initManagePage() {
    $el('manage-word-count').textContent = DB.words.length;
}

function showModal(id) {
    document.getElementById(id).classList.remove('hidden');
}

function hideModal(id) {
    document.getElementById(id).classList.add('hidden');
}

function handleAddWord() {
    const ko = $el('add-word-ko').value.trim();
    const pron = $el('add-word-pron').value.trim();
    const zh = $el('add-word-zh').value.trim();
    const exKo = $el('add-word-ex-ko').value.trim();
    const exZh = $el('add-word-ex-zh').value.trim();

    if (!ko || !zh) {
        toast('请至少填写韩语和中文', 'error');
        return;
    }

    DB.addWord({
        korean: ko,
        pronunciation: pron,
        chinese: zh,
        exampleKo: exKo,
        exampleZh: exZh
    });

    // 清空输入
    $el('add-word-ko').value = '';
    $el('add-word-pron').value = '';
    $el('add-word-zh').value = '';
    $el('add-word-ex-ko').value = '';
    $el('add-word-ex-zh').value = '';

    hideModal('modal-add-word');
    initManagePage();
    toast('单词添加成功！', 'success');
}

function handleImport() {
    const text = document.getElementById('import-textarea').value.trim();
    if (!text) {
        toast('请输入要导入的内容', 'error');
        return;
    }

    const lines = text.split('\n');
    let count = 0;
    lines.forEach(line => {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length >= 3) {
            DB.addWord({
                korean: parts[0],
                pronunciation: parts[1],
                chinese: parts[2],
                exampleKo: parts[3] || '',
                exampleZh: parts[4] || ''
            });
            count++;
        }
    });

    document.getElementById('import-textarea').value = '';
    hideModal('modal-import');
    initManagePage();
    markVocabDirty();   // 导入新词后，下次进入词库整体重建
    toast(`成功导入 ${count} 个单词！`, 'success');
}

function handleExport() {
    const data = {
        words: DB.words,
        exportDate: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `korean-memorizer-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('数据已导出！', 'success');
}

function handleResetProgress() {
    if (confirm('确定要重置所有学习进度吗？此操作不可撤销！')) {
        DB.resetProgress();
        toast('进度已重置', 'success');
        renderHome();
    }
}

function handleClearAll() {
    if (!confirm('确定要清空所有单词吗？\n\n此操作不可撤销！\n清空后你可以重新添加或导入新的单词。')) {
        return;
    }
    DB.clearAllWordsAndTexts();
    toast('已清空所有单词', 'success');
    renderHome();
    initManagePage();
}

// ===== 事件绑定 =====
function bindEvents() {
    // 导航
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => navigateTo(item.dataset.page));
    });

    // 背单词 - 返回课程列表
    document.getElementById('learn-back-btn').addEventListener('click', backToLearnLessons);

    // 背单词 - 模式选择弹窗
    const lms = document.getElementById('learn-mode-start');
    if (lms) lms.addEventListener('click', learnModeStart);
    const lmc = document.getElementById('learn-mode-cancel');
    if (lmc) lmc.addEventListener('click', closeLearnModePicker);
    const lmo = document.getElementById('learn-mode-overlay');
    if (lmo) {
        lmo.addEventListener('click', (e) => { if (e.target === lmo) closeLearnModePicker(); });
        lmo.addEventListener('change', (e) => {
            const t = e.target;
            if (t && (t.dataset.mode || t.name === 'learn-run')) syncLearnModePicker(t);
        });
    }

    // 背单词
    document.getElementById('btn-flip').addEventListener('click', flipCard);
    document.getElementById('card-speak').addEventListener('click', () => {
        const btn = document.getElementById('card-speak');
        if (btn.disabled) return;
        const ko = document.getElementById('card-korean').textContent;
        if (!ko) return;
        const _w = learnQueue[learnIndex];
        Audio.speak(ko, 0.9, _w ? _w.id : null);
    });
    // 单词编辑弹窗
    const weSave = $el('we-save');
    if (weSave) weSave.addEventListener('click', saveWordEdit);
    const weRevert = $el('we-revert');
    if (weRevert) weRevert.addEventListener('click', revertWordEdit);
    // 单词编辑按钮：事件委托（词库列表 + 背单词卡片），不依赖逐行/单次绑定，避免渲染或初始化异常导致失效
    const vlist = document.getElementById('vocab-word-list');
    if (vlist) vlist.addEventListener('click', (e) => {
        const btn = e.target.closest('.vocab-word-edit');
        if (btn) { e.preventDefault(); e.stopPropagation(); openWordEdit(btn.dataset.vwedit); }
    });
    const wcard = document.getElementById('word-card');
    if (wcard) wcard.addEventListener('click', (e) => {
        if (e.target.closest('#card-edit') && learnQueue[learnIndex]) openWordEdit(learnQueue[learnIndex].id);
    });
    document.querySelectorAll('.btn-rate[data-rate]').forEach(btn => {
        btn.addEventListener('click', () => rateWord(parseInt(btn.dataset.rate)));
    });

    // 背单词复习
    document.getElementById('review-flash').addEventListener('click', startFlashReview);
    document.getElementById('review-spell').addEventListener('click', startSpellReview);
    document.getElementById('flash-speak').addEventListener('click', () => {
        const ko = document.getElementById('flash-korean').textContent;
        const _w = flashQueue[flashIndex];
        Audio.speak(ko, 0.9, _w ? _w.id : null);
    });
    document.getElementById('flash-flip').addEventListener('click', flipFlashCard);
    document.querySelectorAll('[data-flash-rate]').forEach(btn => {
        btn.addEventListener('click', () => rateFlashWord(parseInt(btn.dataset.flashRate)));
    });
    document.getElementById('spell-speak').addEventListener('click', () => {
        const word = spellQueue[spellIndex];
        if (word) Audio.speak(word.korean, 0.9, word.id);
    });
    document.getElementById('spell-submit').addEventListener('click', submitSpell);
    document.getElementById('spell-next').addEventListener('click', nextSpell);

    // 手写板（画布）自评模式：模式切换 + 初始化画布
    document.getElementById('spell-mode-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.spell-mode-tab');
        if (tab) setSpellMode(tab.dataset.spellMode);
    });
    // 拼写提示方式切换（听发音 / 看中文 / 两者）
    document.getElementById('spell-prompt-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.spell-prompt-tab');
        if (!tab) return;
        spellPromptMode = tab.dataset.prompt;
        localStorage.setItem('km_spell_prompt', spellPromptMode);
        document.querySelectorAll('.spell-prompt-tab').forEach(t => t.classList.toggle('active', t === tab));
        // 若正在拼写中，立即套用新提示方式
        const w = spellQueue[spellIndex];
        if (w) applySpellPrompt(w);
    });
    setupSpellCanvas();

    document.getElementById('spell-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            if (!document.getElementById('spell-next').classList.contains('hidden')) {
                nextSpell();
            } else {
                submitSpell();
            }
        }
    });

    // 返回按钮
    document.querySelectorAll('[data-back]').forEach(btn => {
        btn.addEventListener('click', () => navigateTo(btn.dataset.back));
    });

    // 计划页 - 步进器
    document.querySelectorAll('.psr-stepper').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.planStep;
            const dir = parseInt(btn.dataset.dir);
            handlePlanStep(type, dir);
        });
    });

    // 计划页 - 启用开关
    document.getElementById('plan-enabled').addEventListener('change', handlePlanToggle);

    // 词库 - 搜索
    const vsi = document.getElementById('vocab-search-input');
    if (vsi) vsi.addEventListener('input', vocabSearch);

    // 背单词 - 卡片左右翻页
    const cp = document.getElementById('card-prev');
    const cn = document.getElementById('card-next');
    if (cp) cp.addEventListener('click', cardPrev);
    if (cn) cn.addEventListener('click', cardNext);

    // 键盘：← → 翻页，空格翻面
    document.addEventListener('keydown', (e) => {
        const learnActive = document.getElementById('page-learn').classList.contains('active');
        const cardVisible = !document.getElementById('learn-container').classList.contains('hidden');
        if (!learnActive || !cardVisible) return;
        if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); cardPrev(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); cardNext(); }
        else if (e.key === ' ') {
            e.preventDefault();
            if (!document.getElementById('btn-flip').classList.contains('hidden')) flipCard();
        }
    });

    // 触摸滑动翻页
    const card = document.getElementById('word-card');
    if (card) {
        let sx = 0, sy = 0;
        card.addEventListener('touchstart', (e) => {
            sx = e.changedTouches[0].clientX;
            sy = e.changedTouches[0].clientY;
        }, { passive: true });
        card.addEventListener('touchend', (e) => {
            const dx = e.changedTouches[0].clientX - sx;
            const dy = e.changedTouches[0].clientY - sy;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
                if (dx < 0) cardNext(); else cardPrev();
            }
        }, { passive: true });
    }
}

// ===== 用户与记录相关事件 =====
// 用 document 级事件委托，避免任何单点绑定失败导致整块功能失灵
function bindProfileEvents() {
    document.addEventListener('click', (e) => {
        const t = e.target.closest ? e.target.closest('button, .profile-chip, [data-close]') : null;
        if (!t) return;

        // 我的页 / 侧边栏
        if (t.id === 'profile-chip' || t.id === 'me-add-user') { openProfileModal(); return; }
        if (t.id === 'new-profile-btn') { createProfile(); return; }
        if (t.id === 'new-profile-cancel') { resetEditorUI(); renderAvatarPicker(); return; }
        if (t.id === 'me-reset-all') { handleResetAllProgress(); return; }
        if (t.id === 'me-reset-lesson') { toggleLessonResetPanel(); return; }
        if (t.id === 'me-export') { exportProgress(); return; }
        if (t.id === 'me-import-progress') {
            const f = document.getElementById('me-progress-file');
            if (f) f.click();
            return;
        }
        // 按课重置面板里的课程按钮
        const item = t.closest('[data-reset-lesson]');
        if (item) { resetLessonProgress(item.dataset.resetLesson); return; }
        // 弹窗关闭
        if (t.dataset && t.dataset.close) { hideModal(t.dataset.close); return; }
    });

    const npn = document.getElementById('new-profile-name');
    if (npn) npn.addEventListener('keydown', (e) => { if (e.key === 'Enter') createProfile(); });

    const imf = document.getElementById('me-progress-file');
    if (imf) {
        imf.addEventListener('change', () => { importProgressFile(imf.files[0]); imf.value = ''; });
    }
}

// ===== 词库（按册/课展示全部单词）=====
let vocabFilter = '';
let vocabBuilt = false;   // 词库 DOM 是否已构建（用于跳过重复重建，消除点词库卡顿）
let vocabDirty = true;    // 数据/进度是否已变动，需要下次进入时重建

function initVocabPage() {
    vocabFilter = '';
    const si = document.getElementById('vocab-search-input');
    if (si) si.value = '';
    // 词库列表点击：事件委托只挂一次（覆盖全部行 + 折叠）
    if (!vocabListDelegated) {
        const listEl = document.getElementById('vocab-word-list');
        if (listEl) { listEl.addEventListener('click', onVocabListClick); vocabListDelegated = true; }
    }
    // 已渲染且数据未变：直接复用现有 DOM，仅恢复「未过滤」显示（瞬间打开，无卡顿）
    if (vocabBuilt && !vocabDirty) {
        applyVocabFilter();
        return;
    }
    renderVocabSidebar();
    renderVocabAll();
    vocabBuilt = true;
    vocabDirty = false;
}

// 数据变动后标脏，下次进入词库时再整体重建（避免编辑/删除时频繁全量重绘）
function markVocabDirty() { vocabDirty = true; }

// 计算某课属于哪个「分组」（册号 或 书名），返回 {key,label,sort,isNum}
function lessonGroupInfo(l) {
    // 内置教材：id 形如 l-{册}-{课}
    if (l.id && l.id.indexOf('l-') === 0) {
        const vol = l.id.split('-')[1];
        const n = parseInt(vol, 10);
        if (!isNaN(n)) return { key: 'v' + n, label: '第 ' + n + ' 册', sort: n, isNum: true };
    }
    // 自定义：以 book 字段为准（老数据用 volume 兼容）
    const raw = (l.book != null ? l.book : l.volume) || '';
    const s = String(raw).trim();
    if (s) {
        const m = s.match(/第\s*(\d+)\s*册/);
        if (m) { const n = parseInt(m[1], 10); return { key: 'v' + n, label: '第 ' + n + ' 册', sort: n, isNum: true }; }
        const n2 = parseInt(s, 10);
        if (!isNaN(n2)) return { key: 'v' + n2, label: '第 ' + n2 + ' 册', sort: n2, isNum: true };
        return { key: 'b_' + s, label: s, sort: s, isNum: false };
    }
    return { key: 'b_未命名书', label: '未命名书', sort: '未命名书', isNum: false };
}

function groupLessonsByVolume() {
    const map = {};
    allLessons().forEach(l => {
        const g = lessonGroupInfo(l);
        if (!map[g.key]) map[g.key] = { key: g.key, label: g.label, sort: g.sort, isNum: g.isNum, lessons: [] };
        map[g.key].lessons.push(l);
    });
    const arr = Object.keys(map).map(k => map[k]);
    arr.sort((a, b) => {
        if (a.isNum && b.isNum) return a.sort - b.sort;
        if (a.isNum) return -1;          // 数字册排前面
        if (b.isNum) return 1;
        return String(a.sort).localeCompare(String(b.sort), 'zh');
    });
    return arr;
}

// 左侧导航：点击跳转到对应课程章节（册可折叠）
function renderVocabSidebar() {
    const sidebar = document.getElementById('vocab-sidebar');
    if (!sidebar) return;
    sidebar.innerHTML = '';
    const groups = groupLessonsByVolume();
    groups.forEach(g => {
        const volEl = document.createElement('div');
        volEl.className = 'vocab-volume';
        const totalWords = g.lessons.reduce((s, l) => s + l.wordIds.length, 0);
        volEl.innerHTML = `<div class="vocab-volume-title" data-vol-side-toggle="${escapeHtml(g.key)}"><span class="vcaret">▾</span><span class="vvt-label">${escapeHtml(g.label)}</span><span class="vocab-volume-count">${g.lessons.length} 课 · ${totalWords} 词</span></div>`;
        const list = document.createElement('div');
        list.className = 'vocab-lesson-list';
        g.lessons.forEach(l => {
            const item = document.createElement('div');
            item.className = 'vocab-lesson-item';
            item.innerHTML = `<span class="vli-title">${escapeHtml(l.title)}</span><span class="vli-count">${l.wordIds.length}</span>`;
            item.addEventListener('click', () => {
                // 若该册被折叠，先展开再滚动
                const vl = volEl.querySelector('.vocab-lesson-list');
                const vt = volEl.querySelector('.vocab-volume-title .vcaret');
                if (vl && vl.classList.contains('collapsed')) {
                    vl.classList.remove('collapsed');
                    if (vt) vt.textContent = '▾';
                }
                const target = document.getElementById('vocab-lesson-' + l.id);
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            list.appendChild(item);
        });
        volEl.appendChild(list);
        sidebar.appendChild(volEl);
    });
    sidebar.querySelectorAll('[data-vol-side-toggle]').forEach(el => {
        el.addEventListener('click', () => {
            const vl = el.parentElement.querySelector('.vocab-lesson-list');
            const caret = el.querySelector('.vcaret');
            if (vl) {
                const hidden = vl.classList.toggle('collapsed');
                if (caret) caret.textContent = hidden ? '▸' : '▾';
            }
        });
    });
}

// 是否为「用户自定义/导入」的单词：内置课 id 形如 l-{vol}-{n}，其余都算自定义可删
function isCustomWord(w) {
    if (!w || !w.lessonId) return false;
    if (/^l-\d+-\d+$/.test(w.lessonId)) return false;
    return true;
}

// 右侧：把所有册/课的所有单词一次性列出（搜索时筛选）
// 词库列表：高性能渲染
//  - 一次性按 lessonId 建索引（O(n)），避免 132 课 × 3148 词 的全量 filter
//  - 整页用单个 HTML 字符串一次性 innerHTML（不再 3148 次 createElement + 每按钮挂监听）
//  - 点击改用事件委托（1 个监听器覆盖全部行）
function renderVocabAll() {
    const header = document.getElementById('vocab-main-header');
    const listEl = document.getElementById('vocab-word-list');
    if (!header || !listEl) return;

    // 一次性把全部单词按 lessonId 归类（O(n)）
    const byLesson = {};
    for (let i = 0; i < DB.words.length; i++) {
        const w = DB.words[i];
        if (!w.lessonId) continue;
        (byLesson[w.lessonId] || (byLesson[w.lessonId] = [])).push(w);
    }

    const groups = groupLessonsByVolume();
    let html = '';
    let totalShown = 0;

    groups.forEach(g => {
        let volInner = '';
        g.lessons.forEach(l => {
            const words = byLesson[l.id];
            if (!words || !words.length) return;
            totalShown += words.length;
            const rows = words.map(w => {
                const edited = (typeof window.WordEdits !== 'undefined') && window.WordEdits.has(w.id);
                const hasExample = w.exampleKo || w.exampleZh;
                const isCustom = isCustomWord(w);
                const hasRec = (typeof window.Recordings !== 'undefined') && Recordings.hasCached(w.id);
                return `<div class="vocab-word-row${edited ? ' is-edited' : ''}" data-wid="${w.id}">` +
                    `<button class="vocab-speak" title="朗读">🔊</button>` +
                    `<button class="vocab-rec${hasRec ? ' has-rec' : ''}" data-vrec="${w.id}" title="${hasRec ? '播放录音（再次点击重录）' : '点击录音'}">🎤</button>` +
                    `<button class="vocab-word-edit" data-vwedit="${w.id}" title="修改单词 / 释义">✎</button>` +
                    `<div class="vocab-word-main">` +
                        `<div class="vocab-word-ko">${escapeHtml(w.korean)}${edited ? '<span class="vocab-word-edited-dot" title="你已修改此词">●</span>' : ''}</div>` +
                        (w.pronunciation ? `<div class="vocab-word-pron">${escapeHtml(w.pronunciation)}</div>` : '') +
                        `<div class="vocab-word-zh">${escapeHtml(w.chinese || '')}</div>` +
                        (hasExample ? `<div class="vocab-word-ex">${w.exampleKo ? escapeHtml(w.exampleKo) : ''}${w.exampleZh ? ' <span class="vocab-word-ex-zh">' + escapeHtml(w.exampleZh) + '</span>' : ''}</div>` : '') +
                    `</div>` +
                    (isCustom ? `<button class="vocab-word-del" data-vwdel="${w.id}" title="删除此单词">✕</button>` : '') +
                `</div>`;
            }).join('');
            volInner += `<div class="vocab-lesson-section" id="vocab-lesson-${l.id}">` +
                `<div class="vocab-lesson-section-head collapsible" data-lesson-toggle="${l.id}"><span class="vcaret">▾</span><span class="vls-title">${escapeHtml(l.title)}</span><span class="vls-count">${words.length} 词</span></div>` +
                `<div class="vocab-lesson-rows">${rows}</div>` +
            `</div>`;
        });
        html += `<div class="vocab-volume-block">` +
            `<div class="vocab-volume-head" data-vol-toggle="${g.key}"><span class="vcaret">▾</span><span class="vvt-label">${escapeHtml(g.label)}</span><span class="vvol-count">${g.lessons.length} 课</span></div>` +
            `<div class="vocab-volume-body">${volInner}</div>` +
        `</div>`;
    });

    listEl.innerHTML = totalShown === 0 ? `<div class="vocab-empty">没有匹配的单词</div>` : html;
    const totalAll = DB.words.length;
    header.innerHTML = `<div class="vmh-title">全部单词</div><div class="vmh-count">共 ${totalAll} 个单词</div>`;
}

// ===== 词库列表点击：事件委托（1 个监听器覆盖全部行 + 折叠）=====
let vocabListDelegated = false;
function onVocabListClick(e) {
    // 册折叠
    const vh = e.target.closest('.vocab-volume-head[data-vol-toggle]');
    if (vh) {
        const body = vh.parentElement.querySelector('.vocab-volume-body');
        const caret = vh.querySelector('.vcaret');
        if (body) { const h = body.classList.toggle('collapsed'); if (caret) caret.textContent = h ? '▸' : '▾'; }
        return;
    }
    // 课折叠
    const lh = e.target.closest('.vocab-lesson-section-head[data-lesson-toggle]');
    if (lh) {
        const rows = lh.parentElement.querySelector('.vocab-lesson-rows');
        const caret = lh.querySelector('.vcaret');
        if (rows) { const h = rows.classList.toggle('collapsed'); if (caret) caret.textContent = h ? '▸' : '▾'; }
        return;
    }
    // 朗读
    const speak = e.target.closest('.vocab-speak');
    if (speak) {
        const row = speak.closest('.vocab-word-row');
        const id = row && row.dataset.wid;
        const w = id && DB.words.find(x => x.id === id);
        if (w) Audio.speak(w.korean, 0.9, w.id);
        return;
    }
    // 录音
    const rec = e.target.closest('.vocab-rec');
    if (rec) { toggleVocabRec(rec, rec.dataset.vrec); return; }
    // 编辑
    const edit = e.target.closest('.vocab-word-edit');
    if (edit) { openWordEdit(edit.dataset.vwedit); return; }
    // 删除（仅自定义词）
    const del = e.target.closest('.vocab-word-del');
    if (del) {
        const id = del.dataset.vwdel;
        const w = DB.words.find(x => x.id === id);
        const ko = w ? w.korean : '';
        if (!confirm('确定删除单词「' + ko + '」吗？\n（这是你导入的词，会同时从学习进度里移除）')) return;
        Custom.removeWord(id);
        // 同时清掉 DB.words（km_words）里的副本，否则下次 DB.load() 会把它们复活
        DB.words = DB.words.filter(x => x.id !== id);
        DB.save();
        renderVocabSidebar();
        rebuildVocabAll();
        toast('已删除单词', 'success');
        return;
    }
}

// ===== 单词编辑（按用户隔离覆盖层）=====
let editingWordId = null;

function openWordEdit(id) {
    if (typeof window.WordEdits === 'undefined') { toast('编辑功能未就绪，请刷新页面后重试', 'error'); return; }
    const w = DB.words.find(x => x.id === id);
    if (!w) return;
    editingWordId = id;
    try {
        const set = (elid, val) => { const e = $el(elid); if (e) e.value = val || ''; };
        set('we-korean', w.korean);
        set('we-pron', w.pronunciation);
        set('we-chinese', w.chinese);
        set('we-exko', w.exampleKo);
        set('we-exzh', w.exampleZh);
        const rev = $el('we-revert');
        if (rev) rev.classList.toggle('hidden', !window.WordEdits.has(id));
        showModal('word-edit-modal');
        setTimeout(() => { const k = $el('we-korean'); if (k) k.focus(); }, 50);
    } catch (err) {
        console.error('openWordEdit 失败', err);
        toast('打开编辑失败：' + (err && err.message ? err.message : err), 'error');
    }
}

function saveWordEdit() {
    if (!editingWordId) return;
    const fields = {
        korean: $el('we-korean').value.trim(),
        pronunciation: $el('we-pron').value.trim(),
        chinese: $el('we-chinese').value.trim(),
        exampleKo: $el('we-exko').value.trim(),
        exampleZh: $el('we-exzh').value.trim()
    };
    if (!fields.korean || !fields.chinese) { toast('韩语和中文都不能为空', 'error'); return; }
    window.WordEdits.set(editingWordId, fields);
    // 原地更新内存 DB.words（learn 队列持有同一引用，会自动同步）
    const idx = DB.words.findIndex(x => x.id === editingWordId);
    if (idx >= 0) Object.assign(DB.words[idx], fields, { _edited: true });
    hideModal('word-edit-modal');
    rebuildVocabAll();
    refreshLearnCardIfVisible();
    toast('已保存修改', 'success');
}

function revertWordEdit() {
    if (!editingWordId) return;
    window.WordEdits.remove(editingWordId);
    const idx = DB.words.findIndex(x => x.id === editingWordId);
    if (idx >= 0) {
        const c = allWords().find(x => x.id === editingWordId);
        if (c) {
            const progress = {};
            ['status', 'box', 'nextReview', 'lastReview', 'reviewCount', 'inWordbook']
                .forEach(f => { if (DB.words[idx][f] !== undefined) progress[f] = DB.words[idx][f]; });
            Object.assign(DB.words[idx], c, progress);
            delete DB.words[idx]._edited;
        }
    }
    hideModal('word-edit-modal');
    rebuildVocabAll();
    refreshLearnCardIfVisible();
    toast('已恢复原始内容', 'success');
}

// 若正在背单词页，刷新当前卡片以反映修改
function refreshLearnCardIfVisible() {
    const active = document.querySelector('.nav-item.active');
    if (active && active.dataset.page === 'learn') showLearnCard();
}

function vocabSearch() {
    const si = document.getElementById('vocab-search-input');
    vocabFilter = si ? si.value : '';
    if (!vocabBuilt) { renderVocabAll(); vocabBuilt = true; vocabDirty = false; }
    // 仅显隐已有节点，不再全量重建（大词库下输入即时响应）
    applyVocabFilter();
}

// 全量重建并保留当前过滤态
function rebuildVocabAll() {
    renderVocabAll();
    vocabBuilt = true;
    vocabDirty = false;
    applyVocabFilter();
}

// 在已构建的 DOM 上做关键词显隐（毫秒级，避免 3148 词重排）
function applyVocabFilter() {
    const listEl = document.getElementById('vocab-word-list');
    if (!listEl) return;
    const f = vocabFilter.trim().toLowerCase();
    let shown = 0;
    listEl.querySelectorAll('.vocab-lesson-section').forEach(sec => {
        let secShown = 0;
        sec.querySelectorAll('.vocab-word-row').forEach(row => {
            const match = !f || row.textContent.toLowerCase().includes(f);
            row.style.display = match ? '' : 'none';
            if (match) { secShown++; shown++; }
        });
        sec.style.display = secShown ? '' : 'none';
    });
    listEl.querySelectorAll('.vocab-volume-block').forEach(vb => {
        const anyVisible = vb.querySelector('.vocab-lesson-section:not([style*="display: none"])');
        vb.style.display = anyVisible ? '' : 'none';
    });
    const header = document.getElementById('vocab-main-header');
    if (header) {
        const totalAll = DB.words.length;
        header.innerHTML = `<div class="vmh-title">全部单词</div><div class="vmh-count">${f ? '匹配 ' + shown + ' / ' + totalAll : '共 ' + totalAll + ' 个单词'}</div>`;
    }
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ===== 用户档案 =====
// 当前正在编辑的用户（null=新建），以及头像选择器当前选中的值（emoji 或 data:URL）
let editingProfileId = null;
let selectedAvatar = null;

// 头像既可以是 emoji，也可以是用户上传的照片（data:URL）
function isPhoto(avatar) {
    return typeof avatar === 'string' && avatar.indexOf('data:') === 0;
}
// 返回可直接塞进 innerHTML 的头像片段
function avatarHTML(avatar) {
    if (isPhoto(avatar)) return `<img class="av-img" src="${avatar}" alt="">`;
    return escapeHtml(avatar || '🐱');
}
// 给一个 DOM 元素设置头像（根据类型决定 textContent 还是 img）
function setAvatarEl(el, avatar) {
    if (!el) return;
    if (isPhoto(avatar)) {
        el.innerHTML = `<img class="av-img" src="${avatar}" alt="">`;
    } else {
        el.textContent = avatar || '🐱';
    }
}

function updateProfileChip() {
    const p = Profiles.current();
    if (!p) return;
    const a = document.getElementById('pc-avatar');
    const n = document.getElementById('pc-name');
    if (a) setAvatarEl(a, p.avatar);  // p.avatar 实际是当前用户的 avatar 字段
    if (n) n.textContent = p.name;
}

function renderProfileGrid(containerId) {
    const box = document.getElementById(containerId);
    if (!box) return;
    let html = '';
    Profiles.list.forEach(p => {
        const st = Profiles.statsOf(p.id);
        const isCur = p.id === Profiles.currentId;
        html += `<div class="profile-item${isCur ? ' current' : ''}" data-profile="${p.id}">
            <div class="pi-avatar">${avatarHTML(p.avatar)}</div>
            <div class="pi-name">${escapeHtml(p.name)}</div>
            <div class="pi-stat">已学 ${st.learned} 词</div>
            ${isCur ? '<div class="pi-badge">当前</div>' : ''}
            <div class="pi-ops">
                <button class="pi-op" data-prof-edit="${p.id}">改头像</button>
                ${Profiles.list.length > 1 ? `<button class="pi-op pi-op-del" data-prof-del="${p.id}">删除</button>` : ''}
            </div>
        </div>`;
    });
    box.innerHTML = html;

    box.querySelectorAll('[data-profile]').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.pi-ops')) return;
            switchProfile(el.dataset.profile);
        });
    });
    box.querySelectorAll('[data-prof-edit]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            editProfile(el.dataset.profEdit);
        });
    });
    box.querySelectorAll('[data-prof-del]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = el.dataset.profDel;
            const p = Profiles.list.find(x => x.id === id);
            if (!confirm(`确定删除用户「${p ? p.name : ''}」吗？\n他的全部学习进度都会被清掉，且无法恢复。`)) return;
            const wasCurrent = id === Profiles.currentId;
            Profiles.remove(id);
            if (wasCurrent) {
                Profiles.applyKeys(Profiles.currentId);
                reloadAfterProfileChange();
            }
            updateProfileChip();
            renderProfileGrid('profile-grid');
            renderProfileGrid('profile-grid-modal');
            toast('已删除该用户', 'success');
        });
    });
}

function switchProfile(id) {
    if (id === Profiles.currentId) {
        hideModal('modal-profile');
        return;
    }
    Profiles.switchTo(id);
    reloadAfterProfileChange();
    markVocabDirty();   // 切换用户后词库进度/录音状态变化，下次进入重建
    updateProfileChip();
    renderProfileGrid('profile-grid');
    renderProfileGrid('profile-grid-modal');
    hideModal('modal-profile');
    toast(`已切换到 ${Profiles.current().name}`, 'success');
}

function reloadAfterProfileChange() {
    DB.load();
    DB.loadPlan();
    const sd = document.getElementById('streak-days');
    if (sd) sd.textContent = DB.stats.streak || 0;
    const active = document.querySelector('.nav-item.active');
    navigateTo(active ? active.dataset.page : 'learn');
}

function renderAvatarPicker() {
    const box = document.getElementById('avatar-picker');
    if (!box) return;
    const sel = selectedAvatar || AVATARS[0];
    let html = '';
    // 若当前选的是照片，先放一个照片选项（已选中）
    if (isPhoto(sel)) {
        html += `<span class="avatar-opt selected av-photo" data-avatar-photo="1"><img class="av-img" src="${sel}" alt=""></span>`;
    }
    html += AVATARS.map(a =>
        `<span class="avatar-opt${a === sel ? ' selected' : ''}" data-avatar="${a}">${a}</span>`
    ).join('');
    // 已选照片时，提供「移除照片」入口（回到 emoji）
    if (isPhoto(sel)) {
        html += `<button type="button" class="avatar-remove-photo" id="avatar-remove-photo" title="移除已上传的照片，改用 emoji">🗑️ 移除照片</button>`;
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-avatar]').forEach(el => {
        el.addEventListener('click', () => {
            selectedAvatar = el.dataset.avatar;
            box.querySelectorAll('.avatar-opt').forEach(x => x.classList.remove('selected'));
            el.classList.add('selected');
        });
    });
    const photoOpt = box.querySelector('[data-avatar-photo]');
    if (photoOpt) {
        photoOpt.addEventListener('click', () => {
            box.querySelectorAll('.avatar-opt').forEach(x => x.classList.remove('selected'));
            photoOpt.classList.add('selected');
        });
    }
    const rm = document.getElementById('avatar-remove-photo');
    if (rm) {
        rm.addEventListener('click', () => {
            selectedAvatar = AVATARS[0];
            renderAvatarPicker();
            toast('已移除照片，可改选 emoji 或重新上传', 'info');
        });
    }
}

// 上传照片设为头像。input 是固定 DOM，用一次性标记防止重复绑定
function bindAvatarUpload() {
    const up = document.getElementById('avatar-upload');
    if (!up || up._bound) return;
    up._bound = true;
    up.addEventListener('change', () => {
        const f = up.files && up.files[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) {
            toast('照片太大了，选张 2MB 以内的吧', 'error');
            up.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            selectedAvatar = reader.result;
            renderAvatarPicker();
            toast('照片已选好，点「保存修改」即可生效', 'success');
        };
        reader.onerror = () => toast('照片读取失败，换张试试', 'error');
        reader.readAsDataURL(f);
        up.value = '';
    });
}

// 把底部编辑器切到「新建」状态
function resetEditorUI() {
    const btn = document.getElementById('new-profile-btn');
    if (btn) btn.textContent = '创建';
    const cancel = document.getElementById('new-profile-cancel');
    if (cancel) cancel.classList.add('hidden');
    const hint = document.getElementById('profile-edit-hint');
    if (hint) hint.classList.add('hidden');
    const nameEl = document.getElementById('new-profile-name');
    if (nameEl) nameEl.value = '';
    selectedAvatar = AVATARS[0];
    editingProfileId = null;
}

// 点「改头像」：把该用户载入底部编辑器
function editProfile(id) {
    const p = Profiles.list.find(x => x.id === id);
    if (!p) return;
    editingProfileId = id;
    selectedAvatar = p.avatar || AVATARS[0];
    const nameEl = document.getElementById('new-profile-name');
    if (nameEl) nameEl.value = p.name;
    const btn = document.getElementById('new-profile-btn');
    if (btn) btn.textContent = '保存修改';
    const cancel = document.getElementById('new-profile-cancel');
    if (cancel) cancel.classList.remove('hidden');
    const hint = document.getElementById('profile-edit-hint');
    if (hint) { hint.textContent = `正在编辑「${p.name}」的头像和昵称`; hint.classList.remove('hidden'); }
    renderAvatarPicker();
    bindAvatarUpload();
    // 编辑器在弹窗内，确保弹窗打开
    showModal('modal-profile');
    // 滚动到编辑器
    const editor = document.querySelector('.profile-new');
    if (editor) editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function createProfile() {
    const nameEl = document.getElementById('new-profile-name');
    const name = (nameEl.value || '').trim();
    if (!name) {
        toast('给新用户起个名字吧', 'error');
        return;
    }
    const av = selectedAvatar || AVATARS[0];
    if (editingProfileId) {
        Profiles.update(editingProfileId, name, av);
        toast('已更新', 'success');
    } else {
        Profiles.add(name, av);
        toast(`欢迎，${name}！`, 'success');
    }
    Profiles.applyKeys(Profiles.currentId);
    resetEditorUI();
    reloadAfterProfileChange();
    updateProfileChip();
    renderProfileGrid('profile-grid');
    renderProfileGrid('profile-grid-modal');
    hideModal('modal-profile');
}

function openProfileModal() {
    resetEditorUI();
    renderProfileGrid('profile-grid-modal');
    renderAvatarPicker();
    bindAvatarUpload();
    showModal('modal-profile');
}

// ===== 界面缩放（用户可调整体大小，覆盖固定 zoom）=====
const UI_ZOOM_KEY = 'km_ui_zoom';
const DEFAULT_UI_ZOOM = 1.1;
const UI_ZOOM_MIN = 0.9, UI_ZOOM_MAX = 1.4;
function clampUiZoom(v) {
  v = parseFloat(v);
  if (isNaN(v)) return DEFAULT_UI_ZOOM;
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, v));
}
function getUiZoom() { return clampUiZoom(localStorage.getItem(UI_ZOOM_KEY)); }
function applyUiZoom(v) {
  v = clampUiZoom(v);
  document.documentElement.style.setProperty('--ui-zoom', String(v));
}
function setUiZoom(v) {
  v = clampUiZoom(v);
  applyUiZoom(v);
  try { localStorage.setItem(UI_ZOOM_KEY, String(v)); } catch (e) {}
}
function syncUiZoomControl() {
  const s = $el('ui-zoom');
  const lbl = $el('ui-zoom-value');
  const v = getUiZoom();
  if (s && s.value !== undefined) s.value = String(v);
  if (lbl && lbl.textContent !== undefined) lbl.textContent = Math.round(v * 100) + '%';
}
function bindUiZoom() {
  const s = $el('ui-zoom');
  const lbl = $el('ui-zoom-value');
  if (!s || !s.addEventListener) return;
  s.addEventListener('input', () => {
    const v = parseFloat(s.value);
    setUiZoom(v);
    if (lbl) lbl.textContent = Math.round(v * 100) + '%';
  });
}

// ===== 发音方式设置 =====
const APP_VERSION = 'v57';   // 改动功能后同步 +1（与 sw.js / build_deploy.py 的版本一致）
function ttsEngineDesc(m) {
  if (m === 'online') return '始终使用在线发音（需联网，手机/平板推荐）';
  if (m === 'local') return '使用系统语音（离线可用，需设备装有韩语语音）';
  return '自动选择：设备有韩语语音用系统发音，没有则用在线发音';
}
function syncTtsModeControl() {
  const m = Audio.getMode();
  document.querySelectorAll('input[name="tts-mode"]').forEach(r => {
    r.checked = (r.value === m);
  });
  const desc = $el('tts-engine-desc');
  if (desc && desc.textContent !== undefined) desc.textContent = ttsEngineDesc(m);
  const ver = $el('app-version');
  if (ver && ver.textContent !== undefined) ver.textContent = APP_VERSION;
}
function bindTtsMode() {
  const radios = document.querySelectorAll('input[name="tts-mode"]');
  if (!radios.length) return;
  radios.forEach(r => {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      Audio.setMode(r.value);
      syncTtsModeControl();
      const name = r.value === 'auto' ? '自动' : (r.value === 'online' ? '在线发音' : '系统发音');
      toast('发音方式已切换为：' + name, 'success');
    });
  });
  const test = $el('tts-test');
  if (test && test.addEventListener) {
    test.addEventListener('click', async () => {
      const ok = await Audio.speak('안녕하세요');
      if (!ok) {
        const why = Audio.getLastError ? Audio.getLastError() : '';
        toast('发音失败：' + (why || '请检查网络或手机音量'), 'error');
      }
    });
  }
  const diag = $el('tts-diag');
  if (diag && diag.addEventListener) {
    diag.addEventListener('click', () => runTtsDiagnostics());
  }

  // 导入词发音代理配置 + 诊断
  const proxyInput = $el('tts-proxy');
  if (proxyInput && !proxyInput.value) {
    try { proxyInput.value = (Audio.getProxy ? Audio.getProxy() : ''); } catch (e) { /* 忽略 */ }
  }
  const proxySave = $el('tts-proxy-save');
  if (proxySave && proxySave.addEventListener) {
    proxySave.addEventListener('click', () => {
      try {
        if (Audio.setProxy) Audio.setProxy(proxyInput ? proxyInput.value : '');
        toast('发音代理已保存（留空则用默认公共代理）', 'success');
        if (Audio.clearTtsCache) Audio.clearTtsCache();
      } catch (e) { toast('保存失败', 'error'); }
    });
  }
  const impDiag = $el('tts-import-diag');
  if (impDiag && impDiag.addEventListener) {
    impDiag.addEventListener('click', async () => {
      const t = window.prompt('输入一个你导入过的韩语词（测试发音链路）：', '');
      if (t == null) return;
      const out = $el('tts-import-diag-out');
      if (!out) return;
      out.classList.remove('hidden');
      out.innerHTML = '<div>诊断中…</div>';
      try {
        const r = await Audio.diagnoseImport(t.trim());
        let html = '<div><b>导入词发音诊断：' + escapeHtml(r.text) + '</b></div>';
        html += '<div class="dim">代理：' + escapeHtml(r.proxy) + '</div>';
        (r.steps || []).forEach(s => {
          html += '<div>' + escapeHtml(s.name) + '：' + (s.ok ? '<span class="ok">✔ 可用</span>' : '<span class="fail">✘ ' + escapeHtml(s.err || '失败') + '</span>') + '</div>';
        });
        out.innerHTML = html;
      } catch (e) {
        out.innerHTML = '<div class="fail">诊断出错：' + escapeHtml(String((e && e.message) || e)) + '</div>';
      }
    });
  }
}

// ===== 发音一键诊断 =====
function testEngineLoad(name, url, cb) {
  const a = document.createElement('audio');
  let done = false;
  const finish = (ok, msg) => {
    if (done) return;
    done = true;
    try { a.removeAttribute('src'); a.load(); } catch (e) { /* 忽略 */ }
    cb(ok, msg);
  };
  a.onerror = () => finish(false, '加载失败(error)');
  a.onloadedmetadata = () => finish(true, '音频有效');
  a.oncanplay = () => finish(true, '可播放');
  a.src = url;
  a.load();
  setTimeout(() => finish(false, '超时(8秒)'), 8000);
}

function runTtsDiagnostics() {
  const out = $el('tts-diag-out');
  if (!out) return;
  out.classList.remove('hidden');
  const esc = escapeHtml;
  let d = null;
  try { d = Audio.diagnose(); } catch (e) { /* 忽略 */ }
  out.innerHTML =
    '<div><b>环境信息</b></div>' +
    '<div>版本：' + esc(APP_VERSION) + '</div>' +
    '<div>当前模式：' + (d ? esc(d.mode) : '?') + '</div>' +
    '<div>移动端判定：' + (d && d.isMobile ? '<span class="ok">是（触屏/UA）</span>' : '<span class="fail">否 —— 平板可能被误判，导致自动模式走系统语音</span>') + '</div>' +
    '<div>系统语音：' + (d && d.synthesisSupported ? '支持' : '<span class="fail">不支持</span>') +
    (d && d.synthesisSupported ? '，韩语语音包：' + (d.hasKoreanVoice ? '<span class="ok">有</span>' : '<span class="fail">无</span>') : '') + '</div>' +
    '<div class="dim" style="margin-top:4px">UA：' + esc(d ? d.ua : '?') + '</div>' +
    '<div style="margin-top:8px"><b>发音服务器连通性测试…</b></div>';

  const q = encodeURIComponent('안녕하세요');
  const engines = [
    { name: '百度', url: 'https://fanyi.baidu.com/gettts?lan=kor&text=' + q + '&spd=3&source=web' },
    { name: '有道', url: 'https://dict.youdao.com/dictvoice?audio=' + q + '&type=2' }
  ];
  engines.forEach((eng) => {
    out.insertAdjacentHTML('beforeend', '<div id="diag-' + eng.name + '">' + eng.name + '：测试中…</div>');
    testEngineLoad(eng.name, eng.url, (ok, msg) => {
      const el = $el('diag-' + eng.name);
      if (el) {
        el.innerHTML = eng.name + '：' + (ok ? '<span class="ok">✔ ' + esc(msg) + '（服务器可达）</span>' : '<span class="fail">✘ ' + esc(msg) + '（被拦截或网络不通）</span>');
      }
    });
  });
  out.insertAdjacentHTML('beforeend', '<div class="dim" style="margin-top:6px">若两个引擎都 ✔ 但仍无声，问题在「播放」环节：请点上方「🔊 试听」并告诉我结果；同时检查平板媒体音量/静音开关。</div>');
}

// ===== 我的页 =====
function initMePage() {
    updateProfileChip();
    renderProfileGrid('profile-grid');
    syncUiZoomControl();
    syncTtsModeControl();
    refreshRecordings();
    const box = document.getElementById('me-lesson-reset');
    if (box) box.classList.add('hidden');
}

function handleResetAllProgress() {
    const p = Profiles.current();
    if (!confirm(`确定要把「${p.name}」的全部学习进度清零吗？\n\n单词不会删除，只是全部变回「未学」，可以从头再背。`)) return;
    DB.resetProgress();
    DB.plan = { enabled: true, dailyWords: 10, dailyTexts: 1, log: {} };
    DB.savePlan();
    toast('进度已清零，可以重新开始了', 'success');
    initMePage();
}

function toggleLessonResetPanel() {
    const box = document.getElementById('me-lesson-reset');
    if (!box) { toast('页面未就绪，请刷新后重试', 'error'); return; }
    if (!box.classList.contains('hidden')) {
        box.classList.add('hidden');
        return;
    }
    try {
        renderLessonResetPanel(box);
    } catch (err) {
        console.error(err);
        box.innerHTML = '<div class="mlr-hint">加载课程列表出错：' + escapeHtml(err && err.message) + '</div>';
        box.classList.remove('hidden');
    }
}

function renderLessonResetPanel(box) {
    box = box || document.getElementById('me-lesson-reset');
    if (!box) return;
    const lessons = DB.getLessons();
    if (!lessons.length) {
        box.innerHTML = '<div class="mlr-hint">还没有课程。</div>';
        box.classList.remove('hidden');
        return;
    }
    let html = '<div class="mlr-hint">点课程名，把这一课的进度清零：</div><div class="mlr-grid">';
    lessons.forEach(l => {
        const ws = l.wordStats || {};
        const learned = ws.learned != null ? ws.learned : 0;
        const total = ws.total != null ? ws.total : (l.words ? l.words.length : 0);
        html += `<button type="button" class="mlr-item" data-reset-lesson="${escapeHtml(l.id)}">
            <span class="mlr-title">${escapeHtml(l.title)}</span>
            <span class="mlr-stat">${learned}/${total} 已学</span>
        </button>`;
    });
    html += '</div>';
    box.innerHTML = html;
    box.classList.remove('hidden');
}

function resetLessonProgress(lessonId, silent) {
    const lesson = allLessons().find(l => l.id === lessonId);
    if (!lesson) return;
    if (!silent && !confirm(`把「${lesson.title}」的学习进度清零？\n单词还在，只是变回未学状态。`)) return;
    DB.words.forEach(w => {
        if (w.lessonId === lessonId) {
            w.status = 'new';
            w.box = 0;
            w.nextReview = 0;
            w.lastReview = null;
            w.reviewCount = 0;
        }
    });
    DB.save();
    if (!silent) {
        toast(`「${lesson.title}」已重置`, 'success');
        const box = document.getElementById('me-lesson-reset');
        if (box && !box.classList.contains('hidden')) renderLessonResetPanel(box);
    }
}

// 课程列表里的「重练」
function replayLesson(lessonId, ev) {
    if (ev) ev.stopPropagation();
    const lesson = allLessons().find(l => l.id === lessonId);
    if (!lesson) return;
    if (!confirm(`重新练习「${lesson.title}」？\n这一课的记忆进度会清零，单词不会丢。`)) return;
    resetLessonProgress(lessonId, true);
    toast('已重置，开始重新练习', 'success');
    openLearnModePicker(lessonId);
}

// ===== 进度导出 / 导入 =====
function exportProgress() {
    const p = Profiles.current();
    const payload = {
        type: 'korean-memorizer-progress',
        version: 1,
        exportedAt: new Date().toISOString(),
        profile: { name: p.name, avatar: p.avatar },
        words: DB.words.map(w => ({
            id: w.id, status: w.status, box: w.box,
            nextReview: w.nextReview, lastReview: w.lastReview,
            reviewCount: w.reviewCount, inWordbook: w.inWordbook
        })),
        stats: DB.stats,
        plan: DB.plan,
        customLessons: Custom.lessons,
        customWords: Custom.words
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `韩语背诵-${p.name}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出进度文件', 'success');
}

function importProgressFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
        try {
            const d = JSON.parse(r.result);
            if (d.type !== 'korean-memorizer-progress') throw new Error('不是本应用的进度文件');
            if (!confirm(`把这份进度导入到当前用户「${Profiles.current().name}」？\n当前进度会被覆盖。`)) return;

            if (Array.isArray(d.customLessons) && d.customLessons.length) {
                const have = new Set(Custom.lessons.map(l => l.id));
                d.customLessons.forEach(l => { if (!have.has(l.id)) Custom.lessons.push(l); });
                const hw = new Set(Custom.words.map(w => w.id));
                (d.customWords || []).forEach(w => { if (!hw.has(w.id)) Custom.words.push(w); });
                Custom.save();
            }
            DB.load();
            const map = new Map((d.words || []).map(w => [w.id, w]));
            DB.words.forEach(w => {
                const s = map.get(w.id);
                if (s) {
                    ['status', 'box', 'nextReview', 'lastReview', 'reviewCount', 'inWordbook']
                        .forEach(f => { if (s[f] !== undefined) w[f] = s[f]; });
                }
            });
            if (d.stats) DB.stats = d.stats;
            DB.save();
            if (d.plan) { DB.plan = d.plan; DB.savePlan(); }
            reloadAfterProfileChange();
            markVocabDirty();   // 进度导入改变单词状态，下次进入词库重建
            toast('进度导入成功', 'success');
        } catch (e) {
            toast('导入失败：' + e.message, 'error');
        }
    };
    r.readAsText(file, 'utf-8');
}

// ===== 初始化 =====
function safeRun(label, fn) {
    try {
        fn();
    } catch (err) {
        console.error('[init:' + label + ']', err);
        window.__initErrors = window.__initErrors || [];
        window.__initErrors.push(label + ': ' + (err && err.message));
    }
}

// 把真实可视高度写入 --app-h，供 body/#app 的 height 使用。
// 解决夸克等不支持 100dvh / 底部工具栏叠加遮挡的浏览器：
// window.innerHeight 在 Chrome 系会随地址栏显隐实时变化，resize 即触发更新。
function setAppH() {
    try {
        const h = window.innerHeight;
        if (h && h > 0) {
            document.documentElement.style.setProperty('--app-h', h + 'px');
        }
    } catch (e) { /* 忽略 */ }
}
window.addEventListener('resize', setAppH);
if (window.visualViewport && window.visualViewport.addEventListener) {
    window.visualViewport.addEventListener('resize', setAppH);
}
// 脚本一加载就先设一次，避免首帧用错高度
setAppH();

// ===== 词库录音管理 =====
let recActiveWordId = null;   // 当前正在录音的 wordId
let recActiveBtn = null;      // 当前录音按钮元素

// 直接触发某词录音按钮的动作（供事件委托复用，不再每按钮挂监听）
async function toggleVocabRec(btn, wordId) {
    if (!btn || !window.Recordings) return;
    // 正在录音 → 停止并保存
    if (Recordings.isRecording()) {
        const ok = await Recordings.stopAndSave(recActiveWordId);
        if (recActiveBtn) {
            recActiveBtn.classList.remove('recording');
            recActiveBtn.textContent = '🎤';
            if (ok) recActiveBtn.classList.add('has-rec');
        }
        recActiveWordId = null;
        recActiveBtn = null;
        if (ok) { toast('录音已保存 ✓', 'success'); refreshRecordings(); }
        else toast('录音失败，请检查麦克风权限', 'error');
        return;
    }
    // 有录音 → 播放
    if (Recordings.hasCached(wordId)) {
        const ok = await Recordings.play(wordId);
        if (!ok) toast('录音播放失败', 'error');
        return;
    }
    // 无录音 → 开始录音
    if (!Recordings.isSupported()) { toast('此浏览器不支持录音（需要麦克风 + MediaRecorder）', 'error'); return; }
    const started = await Recordings.start();
    if (!started || !started.ok) {
        const why = started && started.why;
        let msg = '录音启动失败：' + (why || '未知错误');
        if (why === 'NotAllowedError' || why === 'SecurityError') msg = '麦克风权限被拒绝：请在浏览器地址栏/设置里允许访问麦克风后重试';
        else if (why === 'NotFoundError' || why === 'DevicesNotFoundError') msg = '未检测到麦克风设备，请检查平板麦克风';
        else if (why === 'NotReadableError' || why === 'TrackStartError') msg = '麦克风被其他应用占用，请关闭其他录音软件';
        else if (why === 'unsupported') msg = '此浏览器不支持录音（需要麦克风 + MediaRecorder）';
        toast(msg, 'error');
        return;
    }
    recActiveWordId = wordId;
    recActiveBtn = btn;
    btn.classList.add('recording');
    btn.textContent = '⏹';
    toast('🎤 录音中…再次点击停止', 'info');
}

function updateRecCount() {
    const el = $el('rec-count');
    if (el && window.Recordings) el.textContent = Recordings.count();
}

// 「我的」页逐条录音列表（可播放 / 单独删除）
function renderRecList() {
    const listEl = $el('rec-list');
    if (!listEl || !window.Recordings) return;
    Recordings.listAll().then(ids => {
        if (!ids || !ids.length) {
            listEl.innerHTML = '<div class="rec-empty">还没有录音。去「词库」点 🎤 录一条吧。</div>';
            return;
        }
        const items = ids.map(id => {
            const w = (DB.words && DB.words.find(x => x.id === id)) || null;
            const label = w ? w.korean : id;
            const sub = w && w.chinese ? w.chinese : '';
            return `<div class="rec-item" data-word-id="${escapeHtml(id)}">
                <div class="rec-item-main">
                    <span class="rec-item-word">${escapeHtml(label)}</span>
                    ${sub ? `<span class="rec-item-sub">${escapeHtml(sub)}</span>` : ''}
                </div>
                <div class="rec-item-actions">
                    <button class="rec-play" type="button" title="播放这条录音">🎧</button>
                    <button class="rec-del" type="button" title="删除这条录音">🗑️</button>
                </div>
            </div>`;
        }).join('');
        listEl.innerHTML = items;
    });
}

function refreshRecordings() {
    updateRecCount();
    renderRecList();
}

function init() {
    // 最先设置可视高度，避免底部工具栏遮挡（夸克等浏览器）
    safeRun('setAppH', setAppH);
    // 必须最先执行：在读取任何进度前，把本地旧 word id 迁移到规范 id
    safeRun('migrateWordIds', migrateLegacyWordIds);
    Profiles.init();
    DB.load();
    DB.loadPlan();
    safeRun('audio', () => Audio.init());
    safeRun('recordings', () => { if (window.Recordings) Recordings.init().then(() => refreshRecordings()); });
    safeRun('recClear', () => {
        const rc = $el('rec-clear');
        if (rc) rc.addEventListener('click', async () => {
            if (!confirm('确定清除全部录音吗？此操作不可撤销。')) return;
            if (window.Recordings) { await Recordings.clear(); updateRecCount(); if (typeof renderVocabAll === 'function') renderVocabAll(); toast('已清除全部录音', 'success'); }
        });
        // 逐条录音：播放 / 单独删除
        const listEl = $el('rec-list');
        if (listEl && window.Recordings) {
            listEl.addEventListener('click', async (e) => {
                const btn = e.target.closest('button');
                if (!btn) return;
                const item = btn.closest('.rec-item');
                const wordId = item && item.dataset.wordId;
                if (!wordId) return;
                if (btn.classList.contains('rec-del')) {
                    if (!confirm('删除这条录音？')) return;
                    await Recordings.remove(wordId);
                    toast('已删除该录音', 'success');
                    refreshRecordings();
                    if (typeof renderVocabAll === 'function') renderVocabAll();
                } else if (btn.classList.contains('rec-play')) {
                    await Recordings.play(wordId);
                }
            });
        }
    });
    // 先注册委托类事件，保证「我的」页按钮不受其它绑定失败影响
    safeRun('profileEvents', bindProfileEvents);
    safeRun('events', bindEvents);
    safeRun('importEvents', bindImportEvents);
    safeRun('chip', updateProfileChip);
    safeRun('uiZoom', bindUiZoom);
    safeRun('ttsMode', bindTtsMode);
    applyUiZoom(getUiZoom());
    navigateTo('learn');

    if (window.__initErrors && window.__initErrors.length) {
        setTimeout(() => toast('部分功能初始化异常：' + window.__initErrors[0], 'error'), 800);
    }

    // 连续学习天数
    const sd = document.getElementById('streak-days');
    if (sd) sd.textContent = DB.stats.streak || 0;

    // 检查语音合成支持
    if (!Audio.isTTSSupported()) {
        toast('您的浏览器不支持语音朗读功能', 'error');
    }
}

// 启动
document.addEventListener('DOMContentLoaded', init);
