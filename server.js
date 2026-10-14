const express = require('express');
const Timetable = require('comcigan-parser');
const path = require('path');
const app = express();
const SCHOOL = '서귀포대신중학교';
let client, schoolCode, lastInit = 0;
async function initialize() {
  if (client && schoolCode && Date.now() - lastInit < 3600000) return;
  const t = new Timetable();
  await t.init();
  const schools = await t.search(SCHOOL);
  const match = schools.find(s => s.name === SCHOOL && (s.region === '제주' || String(s.region).includes('제주'))) || schools.find(s => s.name === SCHOOL);
  if (!match) throw new Error('컴시간에서 학교를 찾지 못했습니다.');
  t.setSchool(match.code);
  client = t;
  schoolCode = match.code;
  lastInit = Date.now();
}
app.get('/api/timetable', async (req,res)=>{
  try {
    await initialize();
    const all = await client.getTimetable();
    const week = all?.[2]?.[1];
    if (!Array.isArray(week)) throw new Error('2학년 1반 시간표를 찾지 못했습니다.');
    res.set('Cache-Control','no-store').json({school:SCHOOL,grade:2,classroom:1, fetchedAt:new Date().toISOString(),days:week.map(day=>(day||[]).map((p,i)=>({period:p.classTime||i+1,subject:p.subject||'',teacher:p.teacher||'',modified:!!p.isModify}))) });
  } catch(e) {client=null;schoolCode=null;res.status(502).json({error:e.message||'시간표 조회 실패'});}
});
app.use(express.static(path.join(__dirname,'public')));
app.listen(process.env.PORT||3000,()=>console.log('http://localhost:'+(process.env.PORT||3000)));
