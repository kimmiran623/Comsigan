
'use strict';

const express = require('express');
const Timetable = require('comcigan-parser');
const fs = require('fs');
const path = require('path');

const app = express();

const TTL = 60 * 60 * 1000;

let cache = null;
let cachedAt = 0;
let pending = null;

// school.txt에서 학교명 읽기
function schoolName() {
  const filePath = path.join(__dirname, 'school.txt');

  const lines = fs
    .readFileSync(filePath, 'utf8')
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

// 컴시간 데이터를 기존 화면 형식으로 변환
function convert(raw) {
  const grades = {};

  for (let g = 1; g <= 3; g++) {
    grades[g] = {};

    const classes =
      raw?.[g] ||
      raw?.[String(g)] ||
      {};

    for (const [key, days] of Object.entries(classes)) {
      const n = Number(key);

      if (
        !Number.isInteger(n) ||
        n < 1 ||
        !Array.isArray(days)
      ) {
        continue;
      }

      grades[g][n] = Array.from(
        { length: 5 },
        (_, d) => {
          const periods = Array.isArray(days[d])
            ? days[d]
            : [];

          return periods
            .filter(Boolean)
            .map((p, i) => ({
              period: Number(p.classTime) || i + 1,
              subject: String(p.subject || ''),
              teacher: String(p.teacher || ''),
              modified: Boolean(
                p.isModify || p.changed
              )
            }));
        }
      );
    }
  }

  return grades;
}

// 단계별 오류 메시지 생성
function stageError(stage, error) {
  const message = error?.message || String(error);

  console.error(`[컴시간 ${stage} 실패]`, error);

  if (
    stage === '초기화' &&
    message.includes('식별 코드')
  ) {
    return new Error(
      '컴시간학생 파서 초기화 실패: ' +
      message +
      ' (컴시간 사이트 변경 또는 파서 호환성 문제 가능성)'
    );
  }

  return new Error(
    `컴시간 ${stage} 실패: ${message}`
  );
}

// 컴시간학생 데이터 조회
async function fetchData(force = false) {
  const school = schoolName();

  // 기존 데이터가 유효하면 재사용
  if (
    !force &&
    cache?.school === school &&
    Date.now() - cachedAt < TTL
  ) {
    return cache;
  }

  // 중복 요청 방지
  if (pending) {
    return pending;
  }

  pending = (async () => {
    const client = new Timetable();

    // 1단계: 파서 초기화
    try {
      await client.init({
        maxGrade: 3,
        cache: 0
      });
    } catch (error) {
      throw stageError('초기화', error);
    }

    // 2단계: 학교 검색
    let results;

    try {
      results = await client.search(school);
    } catch (error) {
      throw stageError('학교 검색', error);
    }

    if (!Array.isArray(results)) {
      throw new Error(
        '학교 검색 결과가 올바르지 않습니다.'
      );
    }

    // 정확히 일치하는 학교 선택
    const exact = results.filter(
      item => item.name === school
    );

    if (exact.length === 0) {
      throw new Error(
        `컴시간에서 '${school}' 학교를 찾지 못했습니다.`
      );
    }

    if (exact.length > 1) {
      throw new Error(
        '같은 이름의 학교가 여러 곳 검색됩니다.'
      );
    }

    // 3단계: 학교 설정
    try {
      await client.setSchool(exact[0].code);
    } catch (error) {
      throw stageError('학교 설정', error);
    }

    // 4단계: 시간표 조회
    let raw;

    try {
      raw = await client.getTimetable();
    } catch (error) {
      throw stageError('시간표 조회', error);
    }

    // 5단계: 화면 데이터 변환
    let grades;

    try {
      grades = convert(raw);
    } catch (error) {
      throw stageError('데이터 변환', error);
    }

    const counts = Object.fromEntries(
      [1, 2, 3].map(g => [
        g,
        Object.keys(grades[g]).length
      ])
    );

    if (!Object.values(counts).some(Boolean)) {
      throw new Error(
        '학급 시간표가 비어 있거나 데이터 형식이 변경되었습니다.'
      );
    }

    // 정상 조회 시 캐시 갱신
    cachedAt = Date.now();

    cache = {
      school,
      grades,
      counts,
      fetchedAt: new Date(cachedAt).toISOString(),
      refreshMinutes: 60
    };

    console.log(
      `[컴시간 조회 완료] ${school}`,
      counts
    );

    return cache;
  })();

  try {
    return await pending;

  } catch (error) {
    console.error('[컴시간 조회 오류]', error);

    // 최신 조회 실패 시 이전 정상 데이터 유지
    if (cache?.school === school) {
      return {
        ...cache,
        warning:
          '최신 시간표 조회 실패: ' + error.message
      };
    }

    throw error;

  } finally {
    pending = null;
  }
}

// 시간표 API
app.get('/api/timetable', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    const force = req.query.refresh === '1';

    const data = await fetchData(force);

    res.json(data);

  } catch (error) {
    res.status(502).json({
      error: error.message || '시간표 조회 오류'
    });
  }
});

// 기존 웹사이트 화면 유지
app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

// 서버 실행
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;

  app.listen(PORT, () => {
    console.log(
      `컴시간학생 시간표 서버 실행: ${PORT}`
    );
  });
}

module.exports = app;
