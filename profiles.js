/**
 * profiles.js - 多用户档案 + 自定义词库
 *
 * 设计要点：
 * 1. 词库内容（内置第一册 + 用户导入的课程）全局共享，所有用户看到同一套教材
 * 2. 学习进度（SRS 状态、计划、统计）按用户隔离，互不干扰
 * 3. 默认用户沿用原有的 km_* 键，老数据自动归入「默认用户」，不丢进度
 */

// ===== 自定义词库（导入的内容，全局共享，不区分用户）=====
const CUSTOM_KEYS = {
    lessons: 'km_custom_lessons',
    words: 'km_custom_words'
};

const Custom = {
    lessons: [],
    words: [],

    load() {
        try {
            this.lessons = JSON.parse(localStorage.getItem(CUSTOM_KEYS.lessons) || '[]');
        } catch (e) { this.lessons = []; }
        try {
            this.words = JSON.parse(localStorage.getItem(CUSTOM_KEYS.words) || '[]');
        } catch (e) { this.words = []; }
    },

    save() {
        localStorage.setItem(CUSTOM_KEYS.lessons, JSON.stringify(this.lessons));
        localStorage.setItem(CUSTOM_KEYS.words, JSON.stringify(this.words));
    },

    /**
     * 新增一课自定义单词
     * @param {string} title 课程标题（课名）
     * @param {string} book 书名（自由命名，如 '延世2' / '我的TOPIK词书'）
     * @param {Array} items [{korean, chinese, pronunciation, exampleKo, exampleZh}]
     * @returns {object} 新建的课程对象
     */
    addLesson(title, book, items) {
        const lid = 'ul-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        const wordIds = [];
        items.forEach((it, idx) => {
            const wid = lid + '-w' + idx;
            wordIds.push(wid);
            this.words.push({
                id: wid,
                korean: (it.korean || '').trim(),
                chinese: (it.chinese || '').trim(),
                pronunciation: (it.pronunciation || '').trim(),
                part: '',
                exampleKo: (it.exampleKo || '').trim(),
                exampleZh: (it.exampleZh || '').trim(),
                lessonId: lid
            });
        });
        const lesson = {
            id: lid,
            title: title,
            book: book,
            volume: book,
            wordIds: wordIds,
            textId: null,
            custom: true
        };
        this.lessons.push(lesson);
        this.save();
        return lesson;
    },

    /** 追加单词到已有的自定义课程 */
    appendToLesson(lessonId, items) {
        const lesson = this.lessons.find(l => l.id === lessonId);
        if (!lesson) return 0;
        let n = 0;
        items.forEach((it) => {
            const wid = lessonId + '-w' + Date.now().toString(36) + '-' + n;
            lesson.wordIds.push(wid);
            this.words.push({
                id: wid,
                korean: (it.korean || '').trim(),
                chinese: (it.chinese || '').trim(),
                pronunciation: (it.pronunciation || '').trim(),
                part: '',
                exampleKo: (it.exampleKo || '').trim(),
                exampleZh: (it.exampleZh || '').trim(),
                lessonId: lessonId
            });
            n++;
        });
        this.save();
        return n;
    },

    /** 删除一整课自定义内容 */
    removeLesson(lessonId) {
        this.lessons = this.lessons.filter(l => l.id !== lessonId);
        this.words = this.words.filter(w => w.lessonId !== lessonId);
        this.save();
    },

    /** 删除某一个单词（保留它所在的课，其余单词不动） */
    removeWord(wordId) {
        this.words = this.words.filter(w => w.id !== wordId);
        this.lessons.forEach(l => {
            l.wordIds = l.wordIds.filter(id => id !== wordId);
        });
        this.save();
    },

    clearAll() {
        this.lessons = [];
        this.words = [];
        this.save();
    }
};

// ===== 全局数据视图：内置 + 自定义 =====
function allLessons() {
    return BUILTIN_LESSONS.concat(Custom.lessons);
}

function allWords() {
    return BUILTIN_WORDS.concat(Custom.words);
}

// ===== 单词编辑覆盖层（按用户隔离）=====
// 用户对任何单词（内置或导入）的修改，只存进「当前用户」自己的覆盖层，
// 不改动共享的 BUILTIN_WORDS / Custom.words，因此其他用户的修改不会影响当前用户。
const WordEdits = {
    map: {},
    key() { return Profiles.prefix(Profiles.currentId) + 'word_overrides'; },
    load() {
        try { this.map = JSON.parse(localStorage.getItem(this.key()) || '{}'); }
        catch (e) { this.map = {}; }
    },
    save() { localStorage.setItem(this.key(), JSON.stringify(this.map)); },
    get(id) { return this.map[id] || null; },
    set(id, fields) {
        this.map[id] = Object.assign({}, fields, { _edited: true });
        this.save();
    },
    remove(id) { delete this.map[id]; this.save(); },
    has(id) { return !!this.map[id]; }
};
// 暴露到 window，确保 app.js（独立脚本）无论如何都能访问到编辑覆盖层
if (typeof window !== 'undefined') window.WordEdits = WordEdits;

// ===== 用户档案 =====
const PROFILE_KEYS = {
    list: 'km_profiles',
    current: 'km_current_profile'
};

const AVATARS = ['🐰', '🐱', '🐶', '🦊', '🐻', '🐼', '🐨', '🦁', '🐯', '🐷', '🐸', '🦄'];

const Profiles = {
    list: [],
    currentId: null,

    load() {
        try {
            this.list = JSON.parse(localStorage.getItem(PROFILE_KEYS.list) || '[]');
        } catch (e) { this.list = []; }

        // 首次运行：把已有的 km_* 数据收编为「默认用户」，进度不丢
        if (this.list.length === 0) {
            const hadData = localStorage.getItem('km_words') !== null;
            this.list = [{
                id: 'default',
                name: hadData ? '我' : '我',
                avatar: '🐰',
                createdAt: Date.now()
            }];
            this.save();
        }

        this.currentId = localStorage.getItem(PROFILE_KEYS.current);
        if (!this.currentId || !this.list.find(p => p.id === this.currentId)) {
            this.currentId = this.list[0].id;
        }
    },

    save() {
        localStorage.setItem(PROFILE_KEYS.list, JSON.stringify(this.list));
        if (this.currentId) localStorage.setItem(PROFILE_KEYS.current, this.currentId);
    },

    current() {
        return this.list.find(p => p.id === this.currentId) || this.list[0];
    },

    /** 该用户的存储前缀：默认用户沿用旧键，避免老数据丢失 */
    prefix(id) {
        return id === 'default' ? 'km_' : 'km_' + id + '_';
    },

    /** 把 STORAGE_KEYS 切到指定用户（对象属性可变，无需重新赋值 const） */
    applyKeys(id) {
        const p = this.prefix(id);
        STORAGE_KEYS.words = p + 'words';
        STORAGE_KEYS.texts = p + 'texts';
        STORAGE_KEYS.stats = p + 'stats';
        STORAGE_KEYS.settings = p + 'settings';
        STORAGE_KEYS.dataVersion = p + 'data_version';
        STORAGE_KEYS.plan = p + 'plan';
    },

    init() {
        Custom.load();
        this.load();
        this.applyKeys(this.currentId);
        WordEdits.load();
    },

    add(name, avatar) {
        const id = 'u' + Date.now().toString(36);
        const p = { id, name: name.trim() || '新用户', avatar: avatar || '🐱', createdAt: Date.now() };
        this.list.push(p);
        this.currentId = id;
        this.save();
        return p;
    },

    rename(id, name) {
        const p = this.list.find(x => x.id === id);
        if (p) { p.name = name.trim() || p.name; this.save(); }
    },

    /** 修改已有用户的昵称和头像（头像可为 emoji 或 data:URL 照片） */
    update(id, name, avatar) {
        const p = this.list.find(x => x.id === id);
        if (p) {
            if (name && name.trim()) p.name = name.trim();
            if (avatar) p.avatar = avatar;
            this.save();
        }
    },

    /** 删除用户及其全部进度数据 */
    remove(id) {
        if (this.list.length <= 1) return false;
        const pre = this.prefix(id);
        ['words', 'texts', 'stats', 'settings', 'data_version', 'plan'].forEach(k => {
            localStorage.removeItem(pre + k);
        });
        this.list = this.list.filter(p => p.id !== id);
        if (this.currentId === id) this.currentId = this.list[0].id;
        this.save();
        return true;
    },

    switchTo(id) {
        if (!this.list.find(p => p.id === id)) return false;
        this.currentId = id;
        this.save();
        this.applyKeys(id);
        WordEdits.load();
        return true;
    },

    /** 该用户已学词数，用于用户卡片展示 */
    statsOf(id) {
        const pre = this.prefix(id);
        try {
            const ws = JSON.parse(localStorage.getItem(pre + 'words') || '[]');
            const learned = ws.filter(w => w.status && w.status !== 'new').length;
            return { learned: learned, total: ws.length };
        } catch (e) {
            return { learned: 0, total: 0 };
        }
    }
};
