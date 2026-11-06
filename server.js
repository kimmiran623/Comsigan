
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

const TTL = 60 * 60 * 1000;
const MAX_GRADE = 3;
const MAX_PROBE_CLASS = 15;

let cache = null;
let cachedAt = 0;
let pending = null;

// ES 모듈 라이브러리 불러오기
let ComciganPromise = null;

async function getComcigan() {
  if (!ComciganPromise) {
    ComciganPromise = import('parse-comcigan')
      .then(module => module.default);
  }

  return ComciganPromise;
}

// school.txt에서 학교명 읽기
function schoolName() {
  const file = path.join(__dirname, 'school.txt');

  const lines = fs.readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);

  const school = lines
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#'));

  if (!school) {
    throw new Error('school.txt에 학교명을 입력하세요.');
  }

  return school;
}

// 수업 데이터 변환
function convertLesson(p, index) {
  if (!p) return null;

  if (typeof p === 'string') {
    return {
      period: index + 1,
      subject: p,
      teacher: '',
      modified: false
    };
  }

  if (typeof p !== 'object') return null;

  return {
    period: Number(
      p.classTime ?? p.period ?? p.periodNum
    ) || index + 1,

    subject: String(
      p.subject ?? p.subjectName ?? p.name ?? ''
    ),

    teacher: String(
      p.teacher ?? p.teacherName ?? ''
    ),

    modified: Boolean(
      p.isModify ??
      p.changed ??
      p.modified ??
      false
    )
  };
}

// 학급 시간표를 월~금 배열로 변환
function convertDays(raw) {
  const source =
    raw?.timetable ??
    raw?.schedule ??
    raw?.data ??
    raw;

  const days = Array.from({ length: 5 }, () => []);

  if (!source || typeof source !== 'object') {
    return days;
  }

  // 배열: [월요일, 화요일, ...]
  if (Array.isArray(source)) {
    for (let d = 0; d < 5; d++) {
      const periods = source[d];

      if (!Array.isArray(periods)) continue;

      days[d] = periods
        .map(convertLesson)
        .filter(Boolean);
    }

    return days;
  }

  // 객체: 요일 이름 또는 숫자 키
  const dayNames = [
    ['월', '월요일', 'monday', 'Monday'],
    ['화', '화요일', 'tuesday', 'Tuesday'],
    ['수', '수요일', 'wednesday', 'Wednesday'],
    ['목', '목요일', 'thursday', 'Thursday'],
    ['금', '금요일', 'friday', 'Friday']
  ];

  const keys = Object.keys(source);
  const numeric = keys.filter(k => /^\d+$/.test(k));

  const zeroBased = numeric.includes('0');

  for (let d = 0; d < 5; d++) {
    const candidates = [
      ...dayNames[d],
      String(zeroBased ? d : d + 1)
    ];

    const key = candidates.find(
      candidate => Object.prototype.hasOwnProperty.call(
        source,
        candidate
      )
    );

    if (key === undefined) continue;

    const periods = source[key];

    if (!Array.isArray(periods)) continue;

    days[d] = periods
      .map(convertLesson)
      .filter(Boolean);
  }

  return days;
}

// 학급별 시간표에 실제 수업이 있는지 확인
function hasLessons(days) {
  return days.some(day => day.length > 0);
}

// 학교 정보에서 학년별 학급 수 추출
function getClassCounts(info) {
  const result = {};

  const candidates = [
    info?.classCounts,
    info?.classCount,
    info?.classes,
    info?.학급수,
    info?.data?.classCounts,
    info?.data?.classCount,
    info?.data?.학급수
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    for (let g = 1; g <= MAX_GRADE; g++) {
      const value = Array.isArray(candidate)
        ? candidate[g]
        : candidate[g] ?? candidate[String(g)];

      const count = Number(value);

      if (
        Number.isInteger(count) &&
        count > 0 &&
        count <= 40
      ) {
        result[g] = count;
      }
    }

    if (Object.keys(result).length === MAX_GRADE) {
      break;
    }
  }

  return result;
}

// 학교의 시간표 전체 조회
async function fetchData(force = false) {
  const school = schoolName();

  if (
    !force &&
    cache?.school === school &&
    Date.now() - cachedAt < TTL
  ) {
    return cache;
  }

  if (pending) return pending;

  pending = (async () => {
    const Comcigan = await getComcigan();

    // 학교 검색
    let results;

    try {
      results = await Comcigan.search(school);
    } catch (error) {
      throw new Error(
        '컴시간학생 학교 검색 실패: ' + error.message
      );
    }

    if (!Array.isArray(results)) {
      throw new Error('학교 검색 결과가 올바르지 않습니다.');
    }

    const exact = results.filter(
      item => item.name === school
    );

    if (!exact.length) {
      throw new Error(
        `'${school}' 학교를 찾지 못했습니다.`
      );
    }

    if (exact.length > 1) {
      throw new Error(
        '같은 이름의 학교가 여러 곳 검색됩니다.'
      );
    }

    const client = new Comcigan(exact[0].code);

    // 학급 수 확인
    let info = {};

    try {
      info = await client.schoolInfo();
    } catch (error) {
      console.warn(
        '학교 정보 조회 실패, 학급별 조회 시도:',
        error.message
      );
    }

    const classCounts = getClassCounts(info);

    const grades = {
      1: {},
      2: {},
      3: {}
    };

    // 학년별 학급 조회
    for (let grade = 1; grade <= MAX_GRADE; grade++) {
      const limit =
        classCounts[grade] || MAX_PROBE_CLASS;

      const classNumbers = Array.from(
        { length: limit },
        (_, i) => i + 1
      );

      // 동시에 너무 많은 요청을 보내지 않도록 분할
      for (let start = 0; start < classNumbers.length; start += 4) {
        const batch = classNumbers.slice(start, start + 4);

        const responses = await Promise.all(
          batch.map(async classNum => {
            try {
              const raw = await client.timetable({
                grade,
                classNum
              });

              const days = convertDays(raw);

              return {
                classNum,
                days,
                valid: hasLessons(days)
              };

            } catch (error) {
              console.warn(
                `${grade}학년 ${classNum}반 조회 실패:`,
                error.message
              );

              return {
                classNum,
                valid: false
              };
            }
          })
        );

        for (const item of responses) {
          if (item.valid) {
            grades[grade][item.classNum] = item.days;
          }
        }
      }
    }

    const counts = Object.fromEntries(
      [1, 2, 3].map(g => [
        g,
        Object.keys(grades[g]).length
      ])
    );

    const total = Object.values(counts)
      .reduce((sum, n) => sum + n, 0);

    if (total === 0) {
      throw new Error(
        '시간표 데이터가 비어 있습니다. ' +
        '새 라이브러리의 응답 형식을 확인해야 합니다.'
      );
    }

    cachedAt = Date.now();

    cache = {
      school,
      grades,
      counts,
      fetchedAt: new Date(cachedAt).toISOString(),
      refreshMinutes: 60
    };

    console.log('시간표 조회 완료:', school, counts);

    return cache;
  })();

  try {
    return await pending;

  } catch (error) {
    console.error('시간표 조회 오류:', error);

    if (cache?.school === school) {
      return {
        ...cache,
        warning: error.message
      };
    }

    throw error;

  } finally {
    pending = null;
  }
}

// API
app.get('/api/timetable', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    const data = await fetchData(
      req.query.refresh === '1'
    );

    res.json(data);

  } catch (error) {
    res.status(502).json({
      error: error.message || '시간표 조회 실패'
    });
  }
});

// 기존 웹사이트 화면
app.use(
  express.static(path.join(__dirname, 'public'))
);

// 서버 실행
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;

  app.listen(PORT, () => {
    console.log(`시간표 서버 실행: ${PORT}`);
  });
}

module.exports = app;
