/**
 * srs.js - 艾宾浩斯间隔重复记忆系统
 * 
 * 基于艾宾浩斯遗忘曲线，使用分级复习箱（Leitner System 变体）
 * 每个单词有一个 box 等级（0-8），对应不同的复习间隔
 */

const SRS = (() => {

    // 艾宾浩斯复习间隔（毫秒）
    // box 0: 5分钟（刚开始学）
    // box 1: 30分钟
    // box 2: 12小时
    // box 3: 1天
    // box 4: 2天
    // box 5: 4天
    // box 6: 7天
    // box 7: 15天
    // box 8: 已掌握（不再自动安排复习）
    const INTERVALS = [
        5 * 60 * 1000,           // 5分钟
        30 * 60 * 1000,           // 30分钟
        12 * 60 * 60 * 1000,      // 12小时
        1 * 24 * 60 * 60 * 1000,  // 1天
        2 * 24 * 60 * 60 * 1000,  // 2天
        4 * 24 * 60 * 60 * 1000,  // 4天
        7 * 24 * 60 * 60 * 1000,  // 7天
        15 * 24 * 60 * 60 * 1000, // 15天
        -1                         // 已掌握，不再复习
    ];

    // 间隔显示文本
    const INTERVAL_LABELS = [
        '5分钟后', '30分钟后', '12小时后', '1天后', '2天后',
        '4天后', '7天后', '15天后', '已掌握'
    ];

    /**
     * 评分后更新单词的复习状态
     * @param {Object} word - 单词对象
     * @param {number} rate - 0=不熟悉, 1=模糊, 2=认识
     * @returns {Object} 更新后的单词
     */
    function review(word, rate) {
        const now = Date.now();

        word.lastReview = now;
        word.reviewCount = (word.reviewCount || 0) + 1;

        if (rate === 0) {
            // 不熟悉 → 回到 box 0，5分钟后复习
            word.box = 0;
            word.status = 'learning';
        } else if (rate === 1) {
            // 模糊 → 不升级，但重新安排当前 box 的间隔
            // 如果还在 box 0，保持在 0
            // 如果已在更高 box，降一级
            if (word.box > 0) {
                word.box = Math.max(0, word.box - 1);
            }
            word.status = 'learning';
        } else if (rate === 2) {
            // 认识 → 升一级
            word.box = Math.min(8, word.box + 1);
            if (word.box >= 8) {
                word.status = 'mastered';
            } else {
                word.status = 'reviewing';
            }
        }

        // 设置下次复习时间
        if (word.box >= 8) {
            word.nextReview = -1; // 已掌握
        } else {
            word.nextReview = now + INTERVALS[word.box];
        }

        return word;
    }

    /**
     * 获取需要复习的单词（到期或过期）
     * @param {Array} words - 所有单词
     * @returns {Array} 需要复习的单词
     */
    function getDueWords(words) {
        const now = Date.now();
        return words.filter(w => {
            if (w.status === 'new') return false;
            if (w.status === 'mastered') return false;
            return w.nextReview > 0 && w.nextReview <= now;
        });
    }

    /**
     * 获取需要复习的课文（到期或过期）
     * @param {Array} texts - 所有课文
     * @returns {Array} 需要复习的课文
     */
    function getDueTexts(texts) {
        const now = Date.now();
        return texts.filter(t => {
            if (t.status === 'new') return false;
            if (t.status === 'mastered') return false;
            return t.nextReview > 0 && t.nextReview <= now;
        });
    }

    /**
     * 获取新单词（还没开始学的）
     * @param {Array} words - 所有单词
     * @param {number} limit - 数量限制
     * @returns {Array} 新单词
     */
    function getNewWords(words, limit = 20) {
        return words
            .filter(w => w.status === 'new')
            .slice(0, limit);
    }

    /**
     * 初始化一个新单词的 SRS 状态
     * @param {Object} word - 原始单词
     * @returns {Object} 带SRS状态的单词
     */
    function initWord(word) {
        return {
            ...word,
            status: 'new',
            box: 0,
            nextReview: 0,
            lastReview: 0,
            reviewCount: 0,
            inWordbook: false
        };
    }

    /**
     * 初始化一个新课文的 SRS 状态
     * @param {Object} text - 原始课文
     * @returns {Object} 带SRS状态的课文
     */
    function initText(text) {
        return {
            ...text,
            status: 'new',
            box: 0,
            nextReview: 0,
            lastReview: 0,
            reviewCount: 0
        };
    }

    /**
     * 获取单词的下次复习时间描述
     * @param {Object} word 
     * @returns {string}
     */
    function getNextReviewLabel(word) {
        if (word.status === 'new') return '未学习';
        if (word.status === 'mastered' || word.box >= 8) return '已掌握';
        if (word.nextReview <= Date.now()) return '待复习';
        return INTERVAL_LABELS[word.box] || '未知';
    }

    /**
     * 获取统计信息
     * @param {Array} words 
     * @returns {Object}
     */
    function getStats(words) {
        const total = words.length;
        const learned = words.filter(w => w.status !== 'new').length;
        const reviewDue = getDueWords(words).length;
        const mastered = words.filter(w => w.status === 'mastered').length;
        const learning = words.filter(w => w.status === 'learning' || w.status === 'reviewing').length;

        return { total, learned, reviewDue, mastered, learning };
    }

    /**
     * 获取课文统计信息
     * @param {Array} texts
     * @returns {Object}
     */
    function getTextStats(texts) {
        const total = texts.length;
        const learned = texts.filter(t => t.status !== 'new').length;
        const reviewDue = getDueTexts(texts).length;
        const mastered = texts.filter(t => t.status === 'mastered').length;
        const learning = texts.filter(t => t.status === 'learning' || t.status === 'reviewing').length;

        return { total, learned, reviewDue, mastered, learning };
    }

    /**
     * 重置所有单词进度
     * @param {Array} words 
     * @returns {Array}
     */
    function resetAll(words) {
        return words.map(w => ({
            ...w,
            status: 'new',
            box: 0,
            nextReview: 0,
            lastReview: 0,
            reviewCount: 0,
            inWordbook: false
        }));
    }

    /**
     * 重置所有课文进度
     * @param {Array} texts
     * @returns {Array}
     */
    function resetAllTexts(texts) {
        return texts.map(t => ({
            ...t,
            status: 'new',
            box: 0,
            nextReview: 0,
            lastReview: 0,
            reviewCount: 0
        }));
    }

    return {
        INTERVALS,
        INTERVAL_LABELS,
        review,
        getDueWords,
        getDueTexts,
        getNewWords,
        initWord,
        initText,
        getNextReviewLabel,
        getStats,
        getTextStats,
        resetAll,
        resetAllTexts
    };
})();
