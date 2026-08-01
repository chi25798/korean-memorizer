/**
 * importer.js - 单词导入（PDF / Word / 文本）
 *
 * PDF 用 pdf.js 取文字层，Word(.docx) 用 mammoth 取纯文本，txt/csv/md 直接读。
 * 解析出的候选词条会先进预览表，确认后才写入自定义词库。
 */

const CDN = {
    pdf: [
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
        'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js'
    ],
    pdfWorker: [
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
        'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js'
    ],
    mammoth: [
        'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js',
        'https://unpkg.com/mammoth@1.6.0/mammoth.browser.min.js'
    ],
    xlsx: [
        'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
        'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js'
    ]
};

function loadScriptOnce(urls, checkGlobal) {
    if (window[checkGlobal]) return Promise.resolve();
    let chain = Promise.reject();
    urls.forEach(url => {
        chain = chain.catch(() => new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = () => (window[checkGlobal] ? resolve() : reject(new Error('global missing')));
            s.onerror = () => reject(new Error('load fail ' + url));
            document.head.appendChild(s);
        }));
    });
    return chain;
}

// ===== 文本解析 =====
const HANGUL = '\\uAC00-\\uD7A3\\u1100-\\u11FF\\u3130-\\u318F';
const RE_HAS_HANGUL = new RegExp('[' + HANGUL + ']');
const RE_HAS_CJK = /[\u4E00-\u9FFF]/;

/** 去掉页眉页脚、页码等噪声 */
function isNoiseLine(line) {
    const t = line.trim();
    if (!t) return true;
    if (/^\d{1,4}$/.test(t)) return true;                 // 纯页码
    if (/^[-—=_·.\s]+$/.test(t)) return true;             // 分隔线
    if (t.length > 200) return true;                      // 超长段落，多半是课文
    return false;
}

/**
 * 从一行里提取词条。支持这些常见排版：
 *   中文（韩语）并列多词：叠被子（이불을 정리하다）、刷牙（이를 닦다）、洗脸（세수하다）
 *   한국어    中文
 *   한국어 | 中文
 *   한국어,中文
 *   한국어[名]中文
 *   한국어（你好）        ← 韩语在前，中文用全角/半角括号括起来
 *   안녕하세요（你好）    ← 同上（韩语在外）
 *   你好（안녕하세요）    ← 中文在前，韩语用括号括起来
 *   안녕하세요你好        ← 韩前中后无分隔
 */
function parseLine(line) {
    let t = line.replace(/\s+/g, ' ').trim();
    if (!t || isNoiseLine(t)) return [];
    if (!RE_HAS_HANGUL.test(t) || !RE_HAS_CJK.test(t)) return [];

    // 英文=韩文 中文（可带序号 2. / 10.、英文可含空格、中文可含顿号），
    // 必须在此整体解析；否则下面的「按、拆条」会把中文含义里的顿号误拆。
    const eqRes = parseEnglishEq(t);
    if (eqRes) return eqRes;

    // 一行内可能用「、；;」并列了多个词条，先拆成单条再逐个解析，
    // 避免「只认出第一个」的问题。（「，」/「,」/「|」留作单条内部的韩中分隔符，不在此拆。）
    const clauses = t.split(/[、；;]+/).map(s => s.trim()).filter(Boolean);
    if (clauses.length > 1) {
        const res = [];
        clauses.forEach(c => parseSingle(c).forEach(e => res.push(e)));
        return res;
    }
    return parseSingle(t);
}

/**
 * 识别「英文=韩文 中文」格式，例如：
 *   2. snowboard=스노보드 滑雪板
 *   4. fantasy=판타지 奇幻、科幻
 *   9. coffee shop=커피숍 咖啡厅
 *   10. Hollywood=할리우드 好莱坞
 * 左侧英文：可含空格（coffee shop）、可带序号（2. / 10. / (2)）；
 * 右侧：韩文在前、中文（可含顿号、）在后，中间用空格分隔。
 * 返回 [{korean, chinese}]，不匹配返回 null。英文仅作来源标注，不存入词库。
 */
function parseEnglishEq(line) {
    let t = line.trim();
    // 去掉序号：2.  10.  (2)  （数字 + . 或 ) + 可选空格）
    t = t.replace(/^\s*\d+[\.\)]\s*/, '');
    const eq = t.indexOf('=');
    if (eq < 0) return null;
    const left = t.slice(0, eq).trim();        // 英文（可能含空格）
    const right = t.slice(eq + 1).trim();       // 韩文 中文
    if (!left || !right) return null;
    if (!RE_HAS_HANGUL.test(right) || !RE_HAS_CJK.test(right)) return null;

    // 情形1：韩文（开头连续韩文）+ 空格 + 中文
    let m = right.match(new RegExp('^([' + HANGUL + ']+)\\s+(.+)$'));
    if (m) return [{ korean: m[1].trim(), chinese: m[2].trim() }];

    // 情形2（退化）：韩文与中文紧贴、中间无空格，按首个汉字切分
    m = right.match(new RegExp('^([' + HANGUL + ']+?)([\\u4E00-\\u9FFF].*)$'));
    if (m) return [{ korean: m[1].trim(), chinese: m[2].trim() }];

    return null;
}

/** 解析单条（已不含并列分隔符） */
function parseSingle(t) {
    if (!RE_HAS_HANGUL.test(t) || !RE_HAS_CJK.test(t)) return [];

    const out = [];

    // 情形 A：一行内多个「한국어[词性]中文」
    const inlineRe = new RegExp('([' + HANGUL + '][' + HANGUL + '\\s\\-~()ㆍ.（）]*?)\\s*\\[([^\\]]{1,6})\\]\\s*([\\u4E00-\\u9FFF][^\\[]{0,30})', 'g');
    let m;
    while ((m = inlineRe.exec(t)) !== null) {
        out.push({ korean: m[1].trim(), chinese: m[3].trim().replace(/[,，;；]$/, '') });
    }
    if (out.length) return out;

    // 情形 B：明确分隔符（| , : tab 多空格 －）
    const parts = t.split(/\t+|\s*[|｜]\s*|\s*[,，]\s*|\s{2,}|\s*[:：\-－]\s*/).filter(x => x.trim());
    if (parts.length >= 2) {
        const ko = parts.find(p => RE_HAS_HANGUL.test(p));
        const zh = parts.find(p => RE_HAS_CJK.test(p) && !RE_HAS_HANGUL.test(p));
        if (ko && zh) {
            return [{ korean: cleanKo(ko), chinese: cleanZh(zh) }];
        }
    }

    // 情形 C：括号包裹的「次要语言」
    //   你好（안녕하세요）→ 中文在外、韩语在（）内
    //   안녕하세요（你好）→ 韩语在外、中文在（）内
    //   支持一行内并列多个：叠被子（이불을 정리하다）、刷牙（이를 닦다）、洗脸（세수하다）
    const parenRe = /[（(]([^（）()]{1,40})[)）]/g;
    const parenGroups = [];
    let pm;
    while ((pm = parenRe.exec(t)) !== null) parenGroups.push(pm[1]);
    if (parenGroups.length) {
        const innerKo = parenGroups.find(g => RE_HAS_HANGUL.test(g));
        const innerZh = parenGroups.find(g => RE_HAS_CJK.test(g) && !RE_HAS_HANGUL.test(g));
        // 用占位符替换括号，保留「外-内」的相对位置，再按并列分隔符切分外侧语段
        const SEP = '\u0001';
        const outer = t.replace(/[（(][^（）()]{1,40}[)）]/g, SEP);
        const segRe = new RegExp('[\\u0001、，,；;]+');
        if (innerKo && !innerZh) {
            // 韩语在括号内（中文在外）：如 你好（안녕하세요）、再见（안녕히）
            const zhSegs = outer.split(segRe).map(cleanZh)
                .filter(s => s && RE_HAS_CJK.test(s) && !RE_HAS_HANGUL.test(s));
            if (zhSegs.length === parenGroups.length) {
                return parenGroups.map((g, i) => ({ korean: cleanKo(g), chinese: zhSegs[i] }));
            }
            if (zhSegs.length) return [{ korean: cleanKo(innerKo), chinese: zhSegs.join('') }];
        }
        if (innerZh && !innerKo) {
            // 中文在括号内（韩语在外）：如 안녕하세요（你好）、안녕히（再见）
            const koSegs = outer.split(segRe).map(cleanKo)
                .filter(s => s && RE_HAS_HANGUL.test(s) && !RE_HAS_CJK.test(s));
            if (koSegs.length === parenGroups.length) {
                return parenGroups.map((g, i) => ({ korean: koSegs[i], chinese: cleanZh(g) }));
            }
            if (koSegs.length) return [{ korean: koSegs[0], chinese: cleanZh(innerZh) }];
        }
    }

    // 情形 D：韩文在前中文在后，中间无分隔（先去掉括号内容再匹配）
    const tNoParen = t.replace(/[（(][^（）()]{1,40}[)）]/g, '').trim();
    const re = new RegExp('^([' + HANGUL + '][' + HANGUL + '\\s\\-~ㆍ./]*)\\s*([\\u4E00-\\u9FFF].*)$');
    const mm = tNoParen.match(re);
    if (mm) {
        return [{ korean: cleanKo(mm[1]), chinese: cleanZh(mm[2]) }];
    }
    return [];
}

function cleanKo(s) {
    return s.replace(/^[\d.、)）\s]+/, '').replace(/[\s.,]+$/, '').trim();
}

function cleanZh(s) {
    return s.replace(/^[\s\-—:：,，、；;]+/, '').replace(/[\s;；,，、]+$/, '').trim();
}

/** 整篇文本 -> 候选词条数组（已去重） */
function parseEntries(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    const seen = new Set();
    lines.forEach(line => {
        parseLine(line).forEach(e => {
            // 跳过表头行（韩语,中文 / 韩文 中文 / 朝鲜语 汉语 等）
            if (/^(韩语|韩文|朝鲜语|중국어|korean)$/i.test(e.korean.trim()) &&
                /^(中文|汉语|중국어|chinese)$/i.test(e.chinese.trim())) return;
            if (!e.korean || !e.chinese) return;
            if (e.korean.length > 30 || e.chinese.length > 40) return;
            const key = e.korean + '|' + e.chinese;
            if (seen.has(key)) return;
            seen.add(key);
            out.push(e);
        });
    });
    return out;
}

// ===== 文件读取 =====
function readAsText(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('读取失败'));
        r.readAsText(file, 'utf-8');
    });
}

function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('读取失败'));
        r.readAsArrayBuffer(file);
    });
}

async function extractFromPdf(file) {
    await loadScriptOnce(CDN.pdf, 'pdfjsLib');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker[0];
    const buf = await readAsArrayBuffer(file);
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        // 按 y 坐标分行，尽量还原表格排版
        const rows = {};
        content.items.forEach(it => {
            const y = Math.round(it.transform[5]);
            if (!rows[y]) rows[y] = [];
            rows[y].push({ x: it.transform[4], s: it.str });
        });
        Object.keys(rows)
            .sort((a, b) => b - a)
            .forEach(y => {
                const line = rows[y].sort((a, b) => a.x - b.x).map(o => o.s).join(' ');
                text += line + '\n';
            });
        importSetStatus('正在解析 PDF… ' + i + ' / ' + pdf.numPages + ' 页');
    }
    return text;
}

async function extractFromDocx(file) {
    await loadScriptOnce(CDN.mammoth, 'mammoth');
    const buf = await readAsArrayBuffer(file);
    const res = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return res.value || '';
}

// ===== Excel 解析（SheetJS）=====
async function extractFromXlsx(file) {
    await loadScriptOnce(CDN.xlsx, 'XLSX');
    const buf = await readAsArrayBuffer(file);
    const wb = window.XLSX.read(buf, { type: 'array' });
    const rows = [];
    wb.SheetNames.forEach(name => {
        const ws = wb.Sheets[name];
        const json = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
        json.forEach(r => { if (Array.isArray(r)) rows.push(r); });
    });
    return rows;
}

// 把 Excel 行数组转成候选词条；自动识别表头（韩语/中文/发音/例句）
function rowsToCandidates(rows) {
    if (!rows || !rows.length) return [];
    const head = (rows[0] || []).map(c => String(c == null ? '' : c).trim());
    const idxKo = head.findIndex(h => /^(韩语|韩文|朝鲜语)$|한글|korean/i.test(h));
    const idxZh = head.findIndex(h => /^(中文|汉语)$|chinese/i.test(h));
    const idxPr = head.findIndex(h => /发音|拼音|pron/i.test(h));
    const idxEk = head.findIndex(h => /例句|example\s*ko|korean\s*example/i.test(h));
    const idxEz = head.findIndex(h => /中文例句|例文翻译|example\s*zh|chinese\s*example/i.test(h));
    const hasHeader = idxKo >= 0 || idxZh >= 0;
    const start = hasHeader ? 1 : 0;
    const k0 = idxKo >= 0 ? idxKo : 0;
    const z0 = idxZh >= 0 ? idxZh : 1;
    const out = [];
    const seen = new Set();
    for (let i = start; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r.length) continue;
        const ko = String(r[k0] == null ? '' : r[k0]).trim();
        const zh = String(r[z0] == null ? '' : r[z0]).trim();
        if (!ko || !zh) continue;
        if (!RE_HAS_HANGUL.test(ko)) continue;                 // 跳过没有韩文的行（如纯中文表头/说明）
        if (zh.length > 60 || ko.length > 40) continue;
        const key = ko + '|' + zh;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            korean: ko,
            chinese: zh,
            pronunciation: idxPr >= 0 ? String(r[idxPr] == null ? '' : r[idxPr]).trim() : '',
            exampleKo: idxEk >= 0 ? String(r[idxEk] == null ? '' : r[idxEk]).trim() : '',
            exampleZh: idxEz >= 0 ? String(r[idxEz] == null ? '' : r[idxEz]).trim() : '',
            checked: true
        });
    }
    return out;
}



// ===== 导入页 UI =====
let importCandidates = [];

function importSetStatus(msg, type) {
    const el = document.getElementById('import-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'import-status' + (type ? ' ' + type : '') + (msg ? '' : ' hidden');
}

function initImportPage() {
    importCandidates = [];
    const ta = document.getElementById('import-textarea');
    if (ta) ta.value = '';
    const fi = document.getElementById('import-file');
    if (fi) fi.value = '';
    importSetStatus('');
    renderImportPreview();
    renderBookSelect();
    renderBookDropdown();
    renderCustomLessonList();
}

async function handleImportFile(file) {
    if (!file) return;
    const name = file.name.toLowerCase();
    importSetStatus('正在读取 ' + file.name + ' …');
    try {
        let text = '';
        if (name.endsWith('.pdf')) {
            text = await extractFromPdf(file);
            if (!text.replace(/\s/g, '')) {
                importSetStatus('这个 PDF 是扫描图片，没有文字层，无法直接识别。请改用 Word/文本，或先用 OCR 工具转成文字。', 'error');
                return;
            }
        } else if (name.endsWith('.docx')) {
            text = await extractFromDocx(file);
        } else if (name.endsWith('.doc')) {
            importSetStatus('旧版 .doc 格式无法在网页里解析。请用 Word 打开后「另存为 .docx」再上传。', 'error');
            return;
        } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
            const rows = await extractFromXlsx(file);
            importCandidates = rowsToCandidates(rows);
            if (importCandidates.length === 0) {
                importSetStatus('Excel 里没认出「韩语 + 中文」的词。请确认表格里有韩语列和中文列（可加表头：韩语 / 中文 / 发音 / 例句）。', 'error');
            } else {
                importSetStatus('从 Excel 识别出 ' + importCandidates.length + ' 个单词，核对后点「确认导入」', 'success');
            }
            renderImportPreview();
            return;
        } else {
            text = await readAsText(file);
        }
        document.getElementById('import-textarea').value = text.slice(0, 200000);
        doParseImport();
    } catch (e) {
        importSetStatus('解析失败：' + e.message + '（PDF/Word 解析需要联网加载解析库）', 'error');
    }
}

function doParseImport() {
    const text = document.getElementById('import-textarea').value || '';
    if (!text.trim()) {
        importSetStatus('先选个文件或粘贴一些文字吧', 'error');
        return;
    }
    importCandidates = parseEntries(text).map(e => ({ ...e, checked: true }));
    if (importCandidates.length === 0) {
        importSetStatus('没认出单词。每行请写成「韩语＋中文」的形式，例如：안녕하세요 你好 / 안녕하세요（你好）/ 你好（안녕하세요）/ 책|书', 'error');
    } else {
        importSetStatus('识别出 ' + importCandidates.length + ' 个单词，核对后点「确认导入」', 'success');
    }
    renderImportPreview();
}

function renderImportPreview() {
    const box = document.getElementById('import-preview');
    const cnt = document.getElementById('import-count');
    if (!box) return;
    if (cnt) {
        const n = importCandidates.filter(c => c.checked).length;
        cnt.textContent = importCandidates.length ? '已选 ' + n + ' / ' + importCandidates.length + ' 个' : '';
    }
    if (importCandidates.length === 0) {
        box.innerHTML = '<div class="empty-hint">📄 还没有识别结果</div>';
        return;
    }
    let html = '<table class="import-table"><thead><tr><th style="width:44px">选</th><th>韩语</th><th>中文</th><th style="width:44px">删</th></tr></thead><tbody>';
    importCandidates.forEach((c, i) => {
        html += '<tr>' +
            '<td><input type="checkbox" data-imp-check="' + i + '"' + (c.checked ? ' checked' : '') + '></td>' +
            '<td><input class="imp-input" data-imp-ko="' + i + '" value="' + escapeHtml(c.korean) + '"></td>' +
            '<td><input class="imp-input" data-imp-zh="' + i + '" value="' + escapeHtml(c.chinese) + '"></td>' +
            '<td><button class="imp-del" data-imp-del="' + i + '">✕</button></td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;

    box.querySelectorAll('[data-imp-check]').forEach(el => {
        el.addEventListener('change', () => {
            importCandidates[parseInt(el.dataset.impCheck)].checked = el.checked;
            renderImportPreview();
        });
    });
    box.querySelectorAll('[data-imp-ko]').forEach(el => {
        el.addEventListener('input', () => { importCandidates[parseInt(el.dataset.impKo)].korean = el.value; });
    });
    box.querySelectorAll('[data-imp-zh]').forEach(el => {
        el.addEventListener('input', () => { importCandidates[parseInt(el.dataset.impZh)].chinese = el.value; });
    });
    box.querySelectorAll('[data-imp-del]').forEach(el => {
        el.addEventListener('click', () => {
            importCandidates.splice(parseInt(el.dataset.impDel), 1);
            renderImportPreview();
        });
    });
}

// 已导入的书名去重（用于「放进哪本书」下拉），数字册号在前
function uniqueBookLabels() {
    const map = {};
    Custom.lessons.forEach(l => { const k = customBookLabel(l); map[k] = (map[k] || 0) + 1; });
    const arr = Object.keys(map).map(k => ({ label: k, count: map[k] }));
    arr.sort((a, b) => {
        const na = parseInt(a.label.replace(/[^0-9]/g, ''), 10);
        const nb = parseInt(b.label.replace(/[^0-9]/g, ''), 10);
        const aNum = !isNaN(na) && /^第.*册$/.test(a.label);
        const bNum = !isNaN(nb) && /^第.*册$/.test(b.label);
        if (aNum && bNum) return na - nb;
        if (aNum) return -1;
        if (bNum) return 1;
        return a.label.localeCompare(b.label, 'zh');
    });
    return arr;
}

// 书名下拉（顶层框架）：新建一本书 / 每本已导入的书
function renderBookDropdown() {
    const sel = document.getElementById('import-book-select');
    if (!sel) return;
    let html = '<option value="__newbook__">➕ 新建一本书（含第一课）</option>';
    uniqueBookLabels().forEach(b => {
        html += '<option value="__book__' + escapeHtml(b.label) + '">《' + escapeHtml(b.label) + '》(' + b.count + ' 课)</option>';
    });
    sel.innerHTML = html;
    onBookSelectChange();
}

function getCurrentBookName() {
    const sel = document.getElementById('import-book-select');
    if (!sel || sel.value === '__newbook__') return '';
    return sel.value.replace('__book__', '');
}

// 选好书后，决定是「往这本书加新课」还是「追加到已有课」
function renderAppendTargets() {
    const sel = document.getElementById('import-append-target');
    if (!sel) return;
    const book = getCurrentBookName();
    if (!book) {
        sel.innerHTML = '<option value="__newlesson__">➕ 新建第一课到新书</option>';
        onAppendTargetChange();
        return;
    }
    let html = '<option value="__newlesson__">➕ 新建一课到《' + escapeHtml(book) + '》</option>';
    Custom.lessons.filter(l => customBookLabel(l) === book).forEach(l => {
        html += '<option value="' + l.id + '">↘ 追加到已有课：' + escapeHtml(l.title) + '</option>';
    });
    sel.innerHTML = html;
    onAppendTargetChange();
}

function onBookSelectChange() {
    const sel = document.getElementById('import-book-select');
    const newRow = document.getElementById('import-new-book-row');
    if (!sel || !newRow) return;
    const isNew = sel.value === '__newbook__';
    newRow.classList.toggle('hidden', !isNew);
    if (isNew) updateBookHint();
    renderAppendTargets();
}

function onAppendTargetChange() {
    const sel = document.getElementById('import-append-target');
    const fields = document.getElementById('import-new-fields');
    if (!sel || !fields) return;
    fields.classList.toggle('hidden', sel.value !== '__newlesson__');
}

// 自定义课所属「书名」的显示标签（数字册号→第X册，其余原文）
function customBookLabel(l) {
    const raw = (l.book != null ? l.book : l.volume) || '';
    const s = String(raw).trim();
    if (!s) return '未命名书';
    const n = parseInt(s, 10);
    if (!isNaN(n)) return '第 ' + n + ' 册';
    return s;
}

// 跨 km_custom_words 与 km_words 找词（历史遗留词只在 km_words 里）
function findWordAnywhere(wid) {
    return Custom.words.find(x => x.id === wid) || (typeof DB !== 'undefined' && DB.words ? DB.words.find(x => x.id === wid) : null);
}

// 列出所有「可删除的自定义课」：当前 Custom 课 + 历史遗留在 km_words、未挂到 Custom 课上的词
function customLessonsForDisplay() {
    const list = Custom.lessons.map(l => ({ ...l }));
    const known = new Set(list.map(l => l.id));
    const orphans = {};
    const all = (typeof DB !== 'undefined' && DB.words) ? DB.words : [];
    all.forEach(w => {
        if (!w.lessonId) return;
        if (/^l-\d+-\d+$/.test(w.lessonId)) return; // 内置课
        if (known.has(w.lessonId)) return;          // 已在 Custom 课里
        if (!orphans[w.lessonId]) orphans[w.lessonId] = [];
        orphans[w.lessonId].push(w.id);
    });
    Object.keys(orphans).forEach(lid => {
        list.push({
            id: lid,
            title: '（历史导入）',
            book: '其他导入',
            volume: '其他导入',
            wordIds: orphans[lid],
            custom: true,
            _orphan: true
        });
    });
    return list;
}

// 书名输入：用 datalist 提示已有书名，顶层即「书」
function renderBookSelect() {
    const input = document.getElementById('import-book');
    const list = document.getElementById('book-list');
    if (!input || !list) return;
    const names = new Set();
    Custom.lessons.forEach(l => {
        const raw = (l.book != null ? l.book : l.volume) || '';
        const s = String(raw).trim();
        if (s) names.add(s);
    });
    list.innerHTML = Array.from(names).map(n => '<option value="' + escapeHtml(n) + '"></option>').join('');
    updateBookHint();
}

function updateBookHint() {
    const input = document.getElementById('import-book');
    const hint = document.getElementById('import-book-hint');
    if (!hint) return;
    const v = (input && input.value || '').trim();
    hint.textContent = v
        ? ('👉 这些词将归入《' + v + '》，下面这门课会挂到它下面')
        : '👉 先给这本书起个名字（顶层分组，如「延世2」「我的TOPIK词书」）';
}

function getSelectedBook() {
    const input = document.getElementById('import-book');
    return (input && input.value || '').trim();
}

// onImportTargetChange 已废弃：改用 onBookSelectChange / onAppendTargetChange

function confirmImport() {
    const picked = importCandidates.filter(c => c.checked && c.korean.trim() && c.chinese.trim());
    if (picked.length === 0) {
        importSetStatus('一个单词都没选', 'error');
        return;
    }
    const bookSel = document.getElementById('import-book-select').value;
    let book;
    if (bookSel === '__newbook__') {
        book = getSelectedBook();
        if (!book) {
            importSetStatus('先给新书起个名字（顶层框架：书名）', 'error');
            return;
        }
    } else {
        book = bookSel.replace('__book__', '');
    }
    const appendSel = document.getElementById('import-append-target').value;
    let isAppend = false;
    let targetTitle = '';
    if (appendSel === '__newlesson__') {
        const title = (document.getElementById('import-title').value || '').trim();
        if (!title) {
            importSetStatus('给这一课（属于《' + book + '》）起个名字吧', 'error');
            return;
        }
        Custom.addLesson(title, book, picked);
        targetTitle = title;
    } else {
        // 追加到这本书已有的某一课
        const before = Custom.words.length;
        Custom.appendToLesson(appendSel, picked);
        isAppend = true;
        targetTitle = (Custom.lessons.find(l => l.id === appendSel) || {}).title || '';
        const added = Custom.words.length - before;
        if (added < picked.length) {
            // 部分词已在课内（去重跳过），单独给提示后走通用收尾
            importSetStatus('《' + book + ' · ' + targetTitle + '》已补充 ' + added + ' 个新单词（' + (picked.length - added) + ' 个已存在，自动跳过）；去「背单词」就能看到', 'success');
            toast('已补充 ' + added + ' 个单词', 'success');
            finishImportCommon(picked.map(w => w.korean));
            return;
        }
    }

    // 重新加载词库，新词立刻进入学习体系
    DB.load();
    importCandidates = [];
    document.getElementById('import-textarea').value = '';
    document.getElementById('import-file').value = '';
    document.getElementById('import-title').value = '';
    const bk = document.getElementById('import-book');
    if (bk) bk.value = '';
    renderImportPreview();
    renderBookSelect();
    renderBookDropdown();
    renderCustomLessonList();
    // 新词后台预下载音频（联网时），导入后即可发音、离线也能播
    try {
        if (typeof Audio !== 'undefined' && Audio.precacheImport) {
            Audio.precacheImport(picked.map(w => w.korean));
        }
    } catch (e) { /* 忽略 */ }
    if (isAppend) {
        importSetStatus('已为《' + book + ' · ' + targetTitle + '》补充 ' + picked.length + ' 个单词！去「背单词」就能看到了', 'success');
        toast('已补充 ' + picked.length + ' 个单词', 'success');
    } else {
        importSetStatus('导入成功，新增 ' + picked.length + ' 个单词！去「背单词」就能看到了', 'success');
        toast('已导入 ' + picked.length + ' 个单词', 'success');
    }
}

/** 导入/补充完成后的通用收尾（清空输入框、刷新列表、预下载音频） */
function finishImportCommon(koreans) {
    DB.load();
    importCandidates = [];
    const ta = document.getElementById('import-textarea'); if (ta) ta.value = '';
    const fi = document.getElementById('import-file'); if (fi) fi.value = '';
    const ti = document.getElementById('import-title'); if (ti) ti.value = '';
    const bk = document.getElementById('import-book'); if (bk) bk.value = '';
    renderImportPreview();
    renderBookSelect();
    renderBookDropdown();
    renderCustomLessonList();
    try {
        if (typeof Audio !== 'undefined' && Audio.precacheImport) {
            Audio.precacheImport(koreans && koreans.length ? koreans : importCandidates.map(w => w.korean));
        }
    } catch (e) { /* 忽略 */ }
}

/**
 * 从「已导入的内容」里点「➕ 补充」触发：
 * 跳到导入页，并把书名 / 课预选好，用户只需粘贴新词 → 识别 → 确认即可追加到这一课。
 */
function startSupplement(lessonId) {
    const l = Custom.lessons.find(x => x.id === lessonId);
    if (!l) {
        importSetStatus('找不到这门课，请改用下方下拉框选择', 'error');
        return;
    }
    // 先切到导入页（navigateTo('import') 会 re-init 重置下拉框），再回填预选
    if (typeof navigateTo === 'function') navigateTo('import');
    importCandidates = [];

    const bkLabel = customBookLabel(l);
    const v = '__book__' + escapeHtml(bkLabel);
    const sel = document.getElementById('import-book-select');
    if (sel) {
        const exists = Array.from(sel.options).some(o => o.value === v);
        if (!exists) renderBookDropdown();
        sel.value = v;
    }
    onBookSelectChange();                 // 触发第二个下拉框列出本书已有课
    const asel = document.getElementById('import-append-target');
    if (asel) asel.value = lessonId;      // 直接预选到这一课
    onAppendTargetChange();

    const ta = document.getElementById('import-textarea');
    if (ta) { ta.value = ''; ta.focus(); }
    renderImportPreview();
    importSetStatus('正在为《' + bkLabel + ' · ' + l.title + '》补充单词：粘贴新词后点「🔍 识别单词」，再点「✅ 确认导入」', 'success');
    const wrap = document.querySelector('#page-import .import-wrap');
    if (wrap) wrap.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderCustomLessonList() {
    const box = document.getElementById('import-custom-list');
    if (!box) return;
    // 当前 Custom 课 + 历史遗留在 km_words、未挂到 Custom 课上的自定义词
    const disp = customLessonsForDisplay();
    if (disp.length === 0) {
        box.innerHTML = '<div class="empty-hint">还没有导入过内容</div>';
        return;
    }
    // 按「书名」分组，体现 书名 → 课 → 单词 的层级
    const groups = {};
    disp.forEach(l => {
        const label = customBookLabel(l);
        if (!groups[label]) groups[label] = [];
        groups[label].push(l);
    });
    // 数字册号（第X册）排前面，其余书名按拼音排后面
    const keys = Object.keys(groups);
    keys.sort((a, b) => {
        const na = parseInt(a.replace(/[^0-9]/g, ''), 10);
        const nb = parseInt(b.replace(/[^0-9]/g, ''), 10);
        const aNum = !isNaN(na) && /^第.*册$/.test(a);
        const bNum = !isNaN(nb) && /^第.*册$/.test(b);
        if (aNum && bNum) return na - nb;
        if (aNum) return -1;
        if (bNum) return 1;
        return a.localeCompare(b, 'zh');
    });
    let html = '';
    keys.forEach(k => {
        html += '<div class="clr-group"><div class="clr-group-title">' + escapeHtml(k) + '</div>';
        groups[k].forEach(l => {
            const showSup = !l._orphan;   // 历史遗留课没有稳定归属，不提供「补充」
            html += '<div class="custom-lesson-block">' +
                '<div class="custom-lesson-row" data-cl-toggle="' + l.id + '">' +
                    '<span class="clr-caret">▸</span>' +
                    '<span class="clr-title">' + escapeHtml(l.title) + '</span>' +
                    '<span class="clr-count">' + l.wordIds.length + ' 词</span>' +
                    (showSup ? '<button class="clr-sup" data-cl-sup="' + l.id + '" title="往这一课补充单词">➕ 补充</button>' : '') +
                    '<button class="clr-del" data-cl-del="' + l.id + '">删除整课</button>' +
                '</div>' +
                '<div class="clr-words hidden" data-cl-words="' + l.id + '">';
            l.wordIds.forEach(wid => {
                const w = findWordAnywhere(wid);
                if (!w) return;
                html += '<div class="clr-word-row">' +
                    '<span class="clr-word-ko">' + escapeHtml(w.korean) + '</span>' +
                    '<span class="clr-word-zh">' + escapeHtml(w.chinese || '') + '</span>' +
                    '<button class="clr-word-del" data-cw-del="' + wid + '" data-cw-lesson="' + l.id + '" title="删除这个单词">✕</button>' +
                    '</div>';
            });
            html += '</div></div>';
        });
        html += '</div>';
    });
    box.innerHTML = html;

    // 展开/收起某课下的单词
    box.querySelectorAll('[data-cl-toggle]').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.clr-del') || e.target.closest('.clr-sup')) return; // 点按钮不触发展开
            const id = el.dataset.clToggle;
            const words = box.querySelector('[data-cl-words="' + id + '"]');
            const caret = el.querySelector('.clr-caret');
            if (words) {
                const hidden = words.classList.toggle('hidden');
                if (caret) caret.textContent = hidden ? '▸' : '▾';
            }
        });
    });
    // 往某一课补充单词：直接进入导入页并预选好书+课
    box.querySelectorAll('[data-cl-sup]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            startSupplement(el.dataset.clSup);
        });
    });
    // 删除整课
    box.querySelectorAll('[data-cl-del]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = el.dataset.clDel;
            const l = Custom.lessons.find(x => x.id === id);
            if (!confirm('确定删除「' + (l ? l.title : '') + '」及其全部单词吗？\n（这会同时删掉这课的学习进度）')) return;
            Custom.removeLesson(id);
            // 同时清掉 DB.words（km_words）里的副本，否则下次 DB.load() 会把它们复活
            DB.words = DB.words.filter(x => x.lessonId !== id);
            DB.save();
            renderBookSelect();
            renderBookDropdown();
            renderCustomLessonList();
            toast('已删除整课', 'success');
        });
    });
    // 删除单个单词
    box.querySelectorAll('[data-cw-del]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const wid = el.dataset.cwDel;
            const w = Custom.words.find(x => x.id === wid);
            if (!confirm('确定删除单词「' + (w ? w.korean : '') + '」吗？')) return;
            Custom.removeWord(wid);
            // 同时清掉 DB.words（km_words）里的副本，否则下次 DB.load() 会把它们复活
            DB.words = DB.words.filter(x => x.id !== wid);
            DB.save();
            renderBookSelect();
            renderBookDropdown();
            renderCustomLessonList();
            toast('已删除单词', 'success');
        });
    });
}

function bindImportEvents() {
    const fi = document.getElementById('import-file');
    if (fi) fi.addEventListener('change', () => handleImportFile(fi.files[0]));

    const drop = document.getElementById('import-drop');
    if (drop) {
        drop.addEventListener('click', () => document.getElementById('import-file').click());
        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => {
            e.preventDefault(); drop.classList.add('dragging');
        }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => {
            e.preventDefault(); drop.classList.remove('dragging');
        }));
        drop.addEventListener('drop', (e) => {
            if (e.dataTransfer.files && e.dataTransfer.files[0]) handleImportFile(e.dataTransfer.files[0]);
        });
    }

    const pb = document.getElementById('import-parse-btn');
    if (pb) pb.addEventListener('click', doParseImport);
    const cb = document.getElementById('import-confirm-btn');
    if (cb) cb.addEventListener('click', confirmImport);
    const bsel = document.getElementById('import-book-select');
    if (bsel) bsel.addEventListener('change', onBookSelectChange);
    const asel = document.getElementById('import-append-target');
    if (asel) asel.addEventListener('change', onAppendTargetChange);
    const book = document.getElementById('import-book');
    if (book) book.addEventListener('input', updateBookHint);
    const all = document.getElementById('import-check-all');
    if (all) all.addEventListener('click', () => {
        const anyUnchecked = importCandidates.some(c => !c.checked);
        importCandidates.forEach(c => { c.checked = anyUnchecked; });
        renderImportPreview();
    });
}
