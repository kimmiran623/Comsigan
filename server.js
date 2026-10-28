
const express = require('express');
const path = require('path');
const app = express();

const TTL = 60 * 60 * 1000;
let cache = null;
let cachedAt = 0;
let pending = null;

// Vercel 환경 변수에서 학교코드 읽기
function schoolCode() {
  const value = String(
    process.env.COMCIGAN_SCHOOL_CODE || ''
  ).trim();

  if (!/^\d{1,10}$/.test(value)) {
    throw new Error(
      'COMCIGAN_SCHOOL_CODE 환경 변수에 숫자 학교코드를 설정하세요.'
    );
  }

  return value;
}

// 비공식 교사용 시간표 데이터 조회
async function requestTeacherData(code) {
  const encoded = Buffer.from(
    `73629_${code}_0_1`,
    'utf8'
  ).toString('base64');

  const url =
    `http://comci.net:4082/36179?${encodeURIComponent(encoded)}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(
      `교사용 시간표 서버 응답 오류 (${response.status})`
    );
  }

  const body = (await response.text())
    .replace(/\u0000/g, '');

  let json;

  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(
      '교사용 데이터 형식을 해석하지 못했습니다.'
    );
  }

  if (
    !json ||
    !Array.isArray(json['자료481']) ||
    !Array.isArray(json['자료446']) ||
    !Array.isArray(json['자료492'])
  ) {
    throw new Error(
      '교사용 데이터 구조가 예상과 다릅니다. 실제 응답 구조 확인이 필요합니다.'
    );
  }

  return json;
}

function at(root, ...indices) {
  return indices.reduce(
    (value, index) =>
      Array.isArray(value) ? value[index] : undefined,
    root
  );
}

// 교사용 데이터를 기존 웹앱 형식으로 변환
function convertTeacherData(raw) {
  const teachers = raw['자료446'];
  const subjects = raw['자료492'];
  const classCounts = raw['학급수'];
  const original = raw['자료481'];

  const grades = {};
  let count = 0;

  for (let grade = 1; grade <= 3; grade++) {
    grades[grade] = {};

    const n = Number(at(classCounts, grade) || 0);

    if (
      !Number.isInteger(n) ||
      n < 0 ||
      n > 40
    ) {
      throw new Error(
        '학급 수 데이터가 올바르지 않습니다.'
      );
    }

    for (let cls = 1; cls <= n; cls++) {
      grades[grade][cls] = Array.from(
        { length: 5 },
        (_, day) => {
          const periods = at(
            original,
            grade,
            cls,
            day + 1
          );

          if (!Array.isArray(periods)) {
            return [];
          }

          return periods
            .slice(1)
            .map((value, index) => {
              const code = Number(value || 0);

              if (
                !Number.isInteger(code) ||
                code <= 0
              ) {
                return null;
              }

              const extraTeacher =
                code > 10000
                  ? Math.floor(code / 100000)
                  : 0;

              const rest = extraTeacher
                ? code - extraTeacher * 100000
                : code;

              const teacherId = Math.floor(
                rest / 100
              );

              const subjectId =
                rest - teacherId * 100;

              const teacher = String(
                teachers[teacherId] || ''
              ).trim();

              const subject = String(
                subjects[subjectId] || ''
              ).trim();

              if (!subject && !teacher) {
                return null;
              }

              return {
                period: index + 1,
                subject,
                teacher,
                modified: false
              };
            })
            .filter(Boolean);
        }
      );

      count++;
    }
  }

  if (!count) {
    throw new Error(
      '학급 시간표가 비어 있습니다. 학교코드 또는 데이터 형식을 확인하세요.'
    );
  }

  return grades;
}

// 1시간 캐시
async function fetchData(force) {
  const code = schoolCode();

  if (
    !force &&
    cache &&
    cache.code === code &&
    Date.now() - cachedAt < TTL
  ) {
    return cache.data;
  }

  if (pending) {
    return pending;
  }

  pending = (async () => {
    const raw = await requestTeacherData(code);
    const grades = convertTeacherData(raw);

    const counts = Object.fromEntries(
      [1, 2, 3].map(g => [
        g,
        Object.keys(grades[g]).length
      ])
    );

    const data = {
      school: String(
        process.env.SCHOOL_DISPLAY_NAME ||
        '전 학년 시간표'
      ),
      grades,
      counts,
      fetchedAt: new Date().toISOString(),
      refreshMinutes: 60
    };

    cache = { code, data };
    cachedAt = Date.now();

    return data;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

// 기존 index.html과 동일한 API 주소
app.get('/api/timetable', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    res.json(
      await fetchData(req.query.refresh === '1')
    );
  } catch (error) {
    res.status(502).json({
      error:
        error.message ||
        '교사용 시간표 조회 실패'
    });
  }
});

// 기존 화면 유지
app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

if (require.main === module) {
  app.listen(process.env.PORT || 3000);
}

module.exports = app;
