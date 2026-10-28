const express = require('express');
const Timetable = require('comcigan-parser');
const fs = require('fs');
const path = require('path');
const app = express();
const TTL = 60 * 60 * 1000;
let cache = null, cachedAt = 0, pending = null;
function schoolName() {
  const lines = fs.readFileSync(path.join(__dirname, 'school.txt'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const school = lines.map(s => s.trim()).find(s => s && !s.startsWith('#'));
  if (!school) throw new Error('school.txt에 학교명을 입력하세요.');
  return school;
}
function convert(raw) {
  const grades = {};
  for (let g = 1; g <= 3; g++) {
    grades[g] = {};
    const classes = raw?.[g] || raw?.[String(g)] || {};
    for (const [key, days] of Object.entries(classes)) {
      const n = Number(key);
      if (!Number.isInteger(n) || n < 1 || !Array.isArray(days)) continue;
      grades[g][n] = Array.from({length: 5}, (_, d) => {
        const periods = Array.isArray(days[d]) ? days[d] : [];
        return periods.filter(Boolean).map((p, i) => ({
          period: Number(p.classTime) || i + 1,
          subject: String(p.subject || ''),
          teacher: String(p.teacher || ''),
          modified: Boolean(p.isModify || p.changed)
        }));
      });
    }
  }
  return grades;
}
async function fetchData(force) {
  const school = schoolName();
  if (!force && cache?.school === school && Date.now() - cachedAt < TTL) return cache;
  if (pending) return pending;
  pending = (async () => {
    const client = new Timetable();
    await client.init({maxGrade: 3});
    const results = await client.search(school);
    const exact = results.filter(s => s.name === school);
    if (!exact.length) throw new Error(`컴시간에서 '${school}' 학교를 찾지 못했습니다.`);
    if (exact.length > 1) throw new Error('같은 이름의 학교가 여러 곳 검색됩니다. 학교명만으로 구분할 수 없습니다.');
    client.setSchool(exact[0].code);
    const grades = convert(await client.getTimetable());
    const counts = Object.fromEntries([1,2,3].map(g => [g, Object.keys(grades[g]).length]));
    if (!Object.values(counts).some(Boolean)) throw new Error('학급 시간표가 비어 있거나 데이터 형식이 변경되었습니다.');
    cachedAt = Date.now();
    cache = {school, grades, counts, fetchedAt: new Date(cachedAt).toISOString(), refreshMinutes: 60};
    return cache;
  })();
  try { return await pending; } finally { pending = null; }
}
app.get('/api/timetable', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await fetchData(req.query.refresh === '1')); }
  catch (e) { res.status(502).json({error: e.message || '시간표 조회 오류'}); }
});
app.use(express.static(path.join(__dirname, 'public')));
if (require.main === module) app.listen(process.env.PORT || 3000);
module.exports = app;
