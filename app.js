// 장기요양보험 급여 대시보드
// 데이터는 prepare_data.py가 미리 뽑아 둔 data.json 하나만 읽는다. 가공은 여기서 하지 않는다.
(function () {
  'use strict';

  var METRICS = {
    total:        { label: '총급여',      field: 'total',        unit: '억원' },
    perElder:     { label: '노인 1인당',   field: 'perElder',     unit: '만원' },
    perRecipient: { label: '수급자 1인당', field: 'perRecipient', unit: '만원' },
    coverage:     { label: '수급률',       field: 'coverage',     unit: '%' },
    homeShare:    { label: '재가 비중',    field: 'homeShare',    unit: '%' },
  };

  var PALETTES = {
    light: {
      text: '#1e293b', textMuted: '#64748b', border: '#e2e8f0',
      primary: '#2563eb', accent: '#ea580c', grey: '#cbd5e1', secondary: '#0d9488', tertiary: '#7c3aed', nullBg: '#eef1f5',
      scaleFrom: [219, 234, 254], scaleTo: [30, 58, 138],
    },
    dark: {
      text: '#e2e8f0', textMuted: '#94a3b8', border: '#2c3e5c',
      primary: '#60a5fa', accent: '#fb923c', grey: '#475569', secondary: '#2dd4bf', tertiary: '#a78bfa', nullBg: '#1c293f',
      scaleFrom: [30, 58, 90], scaleTo: [147, 197, 253],
    },
  };

  var state = { year: 2024, metric: 'total', selectedRegion: null };

  var DATA = null;
  var byYear = new Map();        // year -> panel rows
  var byRegionYear = new Map();  // "지역__연도" -> row
  var regionShort = new Map();   // 지역 -> 축약명
  var REGIONS = [];
  var YEARS = [];

  var charts = {};          // key -> echarts instance
  var cartogramCells = new Map(); // 지역 -> DOM 엘리먼트
  var playTimer = null;
  var playing = false;
  var resizeTimer = null;

  // ---------- 유틸 ----------
  function isDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function colors() { return isDark() ? PALETTES.dark : PALETTES.light; }

  function lerpColor(from, to, t) {
    var c = from.map(function (v, i) { return Math.round(v + (to[i] - v) * t); });
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  function fmtNum(n, digits) {
    if (digits === undefined) digits = 1;
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return n.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function sumField(rows, field) {
    return rows.reduce(function (s, r) { return r[field] != null ? s + r[field] : s; }, 0);
  }

  function medianField(rows, field) {
    var vs = rows.map(function (r) { return r[field]; })
                 .filter(function (v) { return v != null; })
                 .sort(function (a, b) { return a - b; });
    if (!vs.length) return NaN;
    var mid = Math.floor(vs.length / 2);
    return vs.length % 2 ? vs[mid] : (vs[mid - 1] + vs[mid]) / 2;
  }

  // 피어슨 상관계수. null은 이미 호출부에서 걸러진 상태로 들어온다.
  function pearson(xs, ys) {
    var n = xs.length;
    if (n < 2) return NaN;
    var mx = xs.reduce(function (a, b) { return a + b; }, 0) / n;
    var my = ys.reduce(function (a, b) { return a + b; }, 0) / n;
    var num = 0, dx2 = 0, dy2 = 0;
    for (var i = 0; i < n; i++) {
      var dx = xs[i] - mx, dy = ys[i] - my;
      num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
    }
    var denom = Math.sqrt(dx2 * dy2);
    return denom === 0 ? NaN : num / denom;
  }

  function setKPI(id, value, sub) {
    var card = document.getElementById(id);
    if (!card) return;
    card.querySelector('.kpi-value').textContent = value;
    card.querySelector('.kpi-sub').textContent = sub;
  }

  // ---------- 오류 처리 ----------
  function showFatalError(err) {
    console.error(err);
    var el = document.getElementById('fatal-error');
    el.hidden = false;
    el.innerHTML =
      '<p>데이터를 불러오지 못했습니다. <code>data.json</code>이 이 페이지와 같은 위치에 있는지 확인해 주세요. ' +
      '(파일을 직접 더블클릭해 열었다면, 브라우저가 로컬 파일 fetch를 막았을 수 있습니다 — 로컬 서버로 열어 주세요.)</p>' +
      '<p class="fatal-detail">' + String((err && err.message) || err) + '</p>';
    document.querySelectorAll('.kpi-value').forEach(function (n) { n.textContent = '—'; });
    document.querySelectorAll('.kpi-sub').forEach(function (n) { n.textContent = '데이터 없음'; });
  }

  // ---------- 색인 구성 ----------
  function buildIndexes() {
    DATA.panel.forEach(function (r) {
      regionShort.set(r.region, r.short);
      if (!byYear.has(r.year)) byYear.set(r.year, []);
      byYear.get(r.year).push(r);
      byRegionYear.set(r.region + '__' + r.year, r);
    });
    REGIONS = Array.from(regionShort.keys()).sort(function (a, b) { return a.localeCompare(b, 'ko'); });
    for (var y = DATA.meta.period[0]; y <= DATA.meta.period[1]; y++) YEARS.push(y);
  }

  // ---------- KPI ----------
  function buildKPI() {
    var y0 = DATA.meta.period[0], y1 = DATA.meta.period[1];
    var rows0 = byYear.get(y0) || [];
    var rows1 = byYear.get(y1) || [];

    var total0 = sumField(rows0, 'total');
    var total1 = sumField(rows1, 'total');
    setKPI('kpi-total',
      fmtNum(total1 / 10000, 1) + '조 원',
      total0 ? (y0 + '년 대비 ' + fmtNum(total1 / total0, 1) + '배') : '');

    var withPop1 = rows1.filter(function (r) { return r.pop65 != null && r.total != null; });
    var natPerElder = withPop1.length ? (sumField(withPop1, 'total') * 10000) / sumField(withPop1, 'pop65') : NaN;
    var perElderVals = rows1.filter(function (r) { return r.perElder != null; }).map(function (r) { return r.perElder; });
    var maxMinRatio = perElderVals.length ? Math.max.apply(null, perElderVals) / Math.min.apply(null, perElderVals) : NaN;
    setKPI('kpi-perelder',
      Number.isNaN(natPerElder) ? '—' : fmtNum(natPerElder, 1) + '만 원',
      Number.isNaN(maxMinRatio) ? '' : '최고·최저 ' + fmtNum(maxMinRatio, 2) + '배 차이');

    // 수급자 수는 연보 주3에 따라 중복배제된 값이라 지역 간 합산이 성립하지 않는다.
    // 그래서 전국 합계 대신 시도별 비율의 중앙값을 쓴다 (비율 계산은 허용된 용법).
    var cov1 = medianField(rows1, 'coverage');
    var cov0 = medianField(rows0, 'coverage');
    var delta = cov1 - cov0;
    setKPI('kpi-coverage',
      Number.isNaN(cov1) ? '—' : fmtNum(cov1, 1) + '%',
      Number.isNaN(delta) ? '' : (y0 + '년 대비 ' + (delta >= 0 ? '+' : '') + fmtNum(delta, 1) + '%p'));

    var mixLast = DATA.mix[DATA.mix.length - 1];
    var mix2012 = DATA.mix.find(function (m) { return m.year === 2012; });
    setKPI('kpi-home',
      fmtNum(mixLast.home, 1) + '%',
      mix2012 ? (mix2012.year + '년 ' + fmtNum(mix2012.home, 1) + '%에서 반등') : '');
  }

  // ---------- 컨트롤 ----------
  function buildControls() {
    var sel = document.getElementById('region-select');
    REGIONS.forEach(function (region) {
      var opt = document.createElement('option');
      opt.value = region;
      opt.textContent = region;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () { selectRegion(sel.value || null); });

    document.querySelectorAll('.metric-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { onMetricChange(btn.dataset.metric); });
    });

    var yearSlider = document.getElementById('year-slider');
    var yearLabel = document.getElementById('year-label');
    yearSlider.addEventListener('input', function () {
      state.year = Number(yearSlider.value);
      yearLabel.textContent = state.year;
      renderSection1();
    });

    var playBtn = document.getElementById('play-btn');
    playBtn.addEventListener('click', function () { togglePlay(playBtn, yearSlider, yearLabel); });
  }

  function onMetricChange(metric) {
    if (!METRICS[metric]) return;
    state.metric = metric;
    document.querySelectorAll('.metric-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.metric === metric);
    });
    document.getElementById('per-elder-warning').hidden = metric !== 'perElder';
    renderSection1();
    renderTrajectory();
  }

  function togglePlay(btn, slider, label) {
    playing = !playing;
    btn.textContent = playing ? '⏸' : '▶';
    btn.setAttribute('aria-label', playing ? '연도 재생 정지' : '연도 재생 시작');
    if (playing) {
      playTimer = setInterval(function () {
        var y = state.year + 1;
        if (y > YEARS[YEARS.length - 1]) y = YEARS[0];
        state.year = y;
        slider.value = y;
        label.textContent = y;
        renderSection1();
      }, 900);
    } else {
      clearInterval(playTimer);
    }
  }

  function selectRegion(region) {
    state.selectedRegion = region || null;
    document.getElementById('region-select').value = state.selectedRegion || '';
    renderCartogram();
    renderRankBar();
    renderTrajectory();
    renderGrowthBar();
    renderDumbbell();
  }

  function renderSection1() {
    renderCartogram();
    renderRankBar();
    renderScatter();
  }

  // ---------- 카토그램 ----------
  function initCartogram() {
    var container = document.getElementById('cartogram');
    var entries = Object.entries(DATA.grid);
    var maxCol = Math.max.apply(null, entries.map(function (e) { return e[1].col; })) + 1;
    var maxRow = Math.max.apply(null, entries.map(function (e) { return e[1].row; })) + 1;
    container.style.gridTemplateColumns = 'repeat(' + maxCol + ', 1fr)';
    container.style.gridTemplateRows = 'repeat(' + maxRow + ', 1fr)';
    container.innerHTML = '';
    cartogramCells.clear();

    entries.forEach(function (entry) {
      var region = entry[0], g = entry[1];
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cartogram-cell';
      cell.style.gridColumn = String(g.col + 1);
      cell.style.gridRow = String(g.row + 1);
      var shortName = regionShort.get(region) || region;
      cell.innerHTML = '<span class="cell-short">' + shortName + '</span><span class="cell-value">--</span>';
      cell.addEventListener('click', function () {
        selectRegion(state.selectedRegion === region ? null : region);
      });
      container.appendChild(cell);
      cartogramCells.set(region, cell);
    });

    renderCartogram();
  }

  function renderCartogram() {
    if (!cartogramCells.size) return;
    var m = METRICS[state.metric];
    var rows = byYear.get(state.year) || [];
    var byRegion = new Map(rows.map(function (r) { return [r.region, r[m.field]]; }));
    var validValues = rows.map(function (r) { return r[m.field]; }).filter(function (v) { return v != null; });
    var min = validValues.length ? Math.min.apply(null, validValues) : 0;
    var max = validValues.length ? Math.max.apply(null, validValues) : 1;
    var pal = colors();

    cartogramCells.forEach(function (cell, region) {
      var val = byRegion.has(region) ? byRegion.get(region) : null; // 행 자체가 없으면(세종 2010~2011) undefined -> null 처리
      var isNull = val == null;
      var isSelected = state.selectedRegion === region;
      cell.classList.toggle('is-null', isNull);
      cell.classList.toggle('is-selected', isSelected);
      var valueEl = cell.querySelector('.cell-value');
      var shortName = regionShort.get(region) || region;

      if (isNull) {
        cell.style.background = pal.nullBg;
        cell.classList.remove('is-dark-cell');
        cell.title = shortName + ' (' + state.year + '년): 자료 없음';
        valueEl.textContent = '자료 없음';
      } else {
        var t = max === min ? 0.5 : (val - min) / (max - min);
        cell.style.background = lerpColor(pal.scaleFrom, pal.scaleTo, t);
        cell.classList.toggle('is-dark-cell', t > 0.55);
        valueEl.textContent = fmtNum(val, 1) + (m.unit === '%' ? '%' : '');
        cell.title = shortName + ' (' + state.year + '년) ' + m.label + ': ' + fmtNum(val, 1) + m.unit;
      }
    });
  }

  // ---------- 순위 막대 ----------
  function renderRankBar() {
    var inst = charts.rank;
    if (!inst) return;
    var m = METRICS[state.metric];
    var pal = colors();
    var rows = (byYear.get(state.year) || [])
      .filter(function (r) { return r[m.field] != null; })
      .slice()
      .sort(function (a, b) { return b[m.field] - a[m.field]; });

    var noteEl = document.getElementById('rank-note');
    var missing = 17 - rows.length;
    noteEl.textContent = state.year + '년 · ' + m.label + ' 기준 내림차순' + (missing > 0 ? ' (자료 없는 시도 ' + missing + '곳 제외)' : '');

    var option = {
      grid: { left: 56, right: 56, top: 8, bottom: 8, containLabel: true },
      tooltip: { trigger: 'item', formatter: function (p) { return p.name + ': ' + fmtNum(p.value, 1) + m.unit; } },
      xAxis: { type: 'value', axisLabel: { color: pal.textMuted }, splitLine: { lineStyle: { color: pal.border } } },
      yAxis: {
        type: 'category', inverse: true,
        data: rows.map(function (r) { return r.short; }),
        axisLabel: { color: pal.text },
        axisLine: { lineStyle: { color: pal.border } },
      },
      series: [{
        type: 'bar',
        data: rows.map(function (r) { return { value: r[m.field], region: r.region }; }),
        itemStyle: {
          color: function (p) { return rows[p.dataIndex].region === state.selectedRegion ? pal.accent : pal.primary; },
          borderRadius: [0, 4, 4, 0],
        },
        label: { show: true, position: 'right', color: pal.text, fontSize: 11, formatter: function (p) { return fmtNum(p.value, 1); } },
        barMaxWidth: 16,
      }],
    };
    inst.setOption(option, true);
  }

  // ---------- 산점도 ----------
  function renderScatter() {
    var inst = charts.scatter;
    if (!inst) return;
    var m = METRICS[state.metric];
    var pal = colors();
    var rows = (byYear.get(state.year) || []).filter(function (r) { return r.agingRate != null && r[m.field] != null; });
    var xs = rows.map(function (r) { return r.agingRate; });
    var ys = rows.map(function (r) { return r[m.field]; });
    var r = pearson(xs, ys);

    var option = {
      title: {
        text: state.year + '년',
        subtext: rows.length >= 2 ? ('피어슨 상관계수 r = ' + (Number.isNaN(r) ? '계산 불가' : r.toFixed(2))) : '자료 부족',
        left: 0, top: 0,
        textStyle: { color: pal.textMuted, fontSize: 12, fontWeight: 400 },
        subtextStyle: { color: pal.text, fontSize: 13, fontWeight: 700 },
      },
      grid: { left: 58, right: 20, top: 72, bottom: 46, containLabel: true },
      tooltip: {
        trigger: 'item',
        formatter: function (p) {
          return p.data.short + '<br>고령화율 ' + fmtNum(p.value[0], 1) + '%<br>' + m.label + ' ' + fmtNum(p.value[1], 1) + m.unit;
        },
      },
      xAxis: {
        type: 'value', name: '고령화율(%)', nameLocation: 'middle', nameGap: 28,
        axisLabel: { color: pal.textMuted }, splitLine: { lineStyle: { color: pal.border } },
      },
      yAxis: {
        // 한글 축 이름은 세로로 세우면 읽기 어려워서 축 위쪽에 가로로 놓는다
        type: 'value', name: m.label + '(' + m.unit + ')',
        nameLocation: 'end', nameRotate: 0, nameGap: 12,
        nameTextStyle: { align: 'left', color: pal.textMuted },
        axisLabel: { color: pal.textMuted }, splitLine: { lineStyle: { color: pal.border } },
      },
      series: [{
        type: 'scatter',
        symbolSize: 14,
        data: rows.map(function (r) { return { value: [r.agingRate, r[m.field]], region: r.region, short: r.short }; }),
        itemStyle: {
          color: function (p) { return p.data.region === state.selectedRegion ? pal.accent : pal.primary; },
          opacity: 0.85,
        },
        label: { show: true, formatter: function (p) { return p.data.short; }, position: 'top', color: pal.textMuted, fontSize: 10 },
        // 지역이 중앙에 몰려 라벨이 겹치므로 자동으로 정리하되, 선택된 지역만은 겹쳐도 항상 보이게 한다
        labelLayout: function (p) {
          var d = rows[p.dataIndex];
          return { hideOverlap: !(d && d.region === state.selectedRegion) };
        },
      }],
    };
    inst.setOption(option, true);
  }

  // ---------- 전국 총급여 추이 ----------
  function renderTrendArea() {
    var inst = charts.trend;
    if (!inst) return;
    var pal = colors();
    var totals = YEARS.map(function (y) { return sumField(byYear.get(y) || [], 'total') / 10000; }); // 억원 -> 조원

    var option = {
      tooltip: {
        trigger: 'axis',
        formatter: function (p) { return p[0].axisValue + '년<br>' + fmtNum(p[0].value, 1) + '조 원'; },
      },
      grid: { left: 56, right: 20, top: 40, bottom: 36, containLabel: true },
      xAxis: {
        type: 'category', data: YEARS.map(String),
        axisLabel: { color: pal.textMuted }, axisLine: { lineStyle: { color: pal.border } },
      },
      yAxis: {
        type: 'value', name: '조 원',
        nameLocation: 'end', nameRotate: 0, nameGap: 12,
        nameTextStyle: { align: 'left', color: pal.textMuted },
        axisLabel: { color: pal.textMuted }, splitLine: { lineStyle: { color: pal.border } },
      },
      series: [{
        type: 'line', data: totals, smooth: true, showSymbol: false,
        lineStyle: { color: pal.primary, width: 2 },
        areaStyle: { color: pal.primary, opacity: 0.18 },
        markLine: {
          symbol: 'none', silent: true,
          lineStyle: { color: pal.accent, type: 'dashed' },
          label: { color: pal.accent, formatter: function (p) { return p.name; }, fontSize: 11 },
          data: [
            { xAxis: '2014', name: '4·5등급 신설' },
            { xAxis: '2018', name: '인지지원등급 신설' },
          ],
        },
      }],
    };
    inst.setOption(option, true);
  }

  // ---------- 시도별 궤적 ----------
  function renderTrajectory() {
    var inst = charts.trajectory;
    if (!inst) return;
    var m = METRICS[state.metric];
    var pal = colors();

    var byRegion = REGIONS.map(function (region) {
      return {
        region: region,
        rows: DATA.panel
          .filter(function (r) { return r.region === region && r[m.field] != null; })
          .sort(function (a, b) { return a.year - b.year; }),
      };
    }).filter(function (d) { return d.rows.length; });

    // 아무것도 선택하지 않았을 때도 읽을 거리가 있도록 최종연도 최상·최하 시도에만 이름을 붙인다
    var lastVals = byRegion.map(function (d) { return d.rows[d.rows.length - 1][m.field]; });
    var topRegion = byRegion[lastVals.indexOf(Math.max.apply(null, lastVals))].region;
    var botRegion = byRegion[lastVals.indexOf(Math.min.apply(null, lastVals))].region;

    var series = byRegion.map(function (d) {
      var isSel = d.region === state.selectedRegion;
      var dimmed = !!(state.selectedRegion && !isSel);
      var isEdge = !state.selectedRegion && (d.region === topRegion || d.region === botRegion);
      var labeled = isSel || isEdge;
      return {
        name: regionShort.get(d.region),
        type: 'line', showSymbol: false,
        data: d.rows.map(function (r) { return [r.year, r[m.field]]; }),
        lineStyle: {
          width: isSel ? 3 : (isEdge ? 2 : 1.2),
          color: isSel ? pal.accent : (isEdge ? pal.text : pal.grey),
          opacity: isSel || isEdge ? 1 : (dimmed ? 0.45 : 0.75),
        },
        endLabel: labeled ? {
          show: true, color: isSel ? pal.accent : pal.text, fontSize: 11,
          formatter: function (p) { return p.seriesName; },
        } : { show: false },
        z: isSel ? 10 : (isEdge ? 5 : 1),
        silent: dimmed,
      };
    });

    var option = {
      tooltip: {
        trigger: 'item',
        formatter: function (p) { return p.seriesName + '<br>' + p.value[0] + '년 ' + fmtNum(p.value[1], 1) + m.unit; },
      },
      grid: { left: 56, right: 52, top: 34, bottom: 36, containLabel: true },
      xAxis: {
        type: 'value', min: YEARS[0], max: YEARS[YEARS.length - 1],
        axisLabel: { color: pal.textMuted, formatter: function (v) { return String(v); } },
        splitLine: { show: false }, axisLine: { lineStyle: { color: pal.border } },
      },
      yAxis: {
        type: 'value', name: m.label + '(' + m.unit + ')',
        nameLocation: 'end', nameRotate: 0, nameGap: 12,
        nameTextStyle: { align: 'left', color: pal.textMuted },
        axisLabel: { color: pal.textMuted }, splitLine: { lineStyle: { color: pal.border } },
      },
      series: series,
    };
    inst.setOption(option, true);
  }

  // ---------- 성장 배수 ----------
  function renderGrowthBar() {
    var inst = charts.growth;
    if (!inst) return;
    var pal = colors();

    var items = REGIONS.map(function (region) {
      var rows = DATA.panel
        .filter(function (r) { return r.region === region && r.total != null; })
        .sort(function (a, b) { return a.year - b.year; });
      if (!rows.length) return null;
      var first = rows[0];
      var last = rows.find(function (r) { return r.year === 2024; });
      if (!last || first.year === last.year) return null;
      return { region: region, short: regionShort.get(region), ratio: last.total / first.total, baseYear: first.year };
    }).filter(Boolean).sort(function (a, b) { return b.ratio - a.ratio; });

    var option = {
      tooltip: {
        trigger: 'item',
        formatter: function (p) {
          var it = items[p.dataIndex];
          return it.short + '<br>' + it.baseYear + '→2024년 ' + fmtNum(it.ratio, 2) + '배' + (it.baseYear !== 2010 ? ' (세종은 2012년 기준)' : '');
        },
      },
      // 막대 위 값 라벨과 축 이름이 겹치지 않게 상단 여백을 넉넉히 둔다
      grid: { left: 46, right: 10, top: 44, bottom: 40, containLabel: true },
      xAxis: {
        type: 'category',
        data: items.map(function (it) { return it.short + (it.baseYear !== 2010 ? '*' : ''); }),
        axisLabel: { color: pal.textMuted, interval: 0 }, axisLine: { lineStyle: { color: pal.border } },
      },
      yAxis: {
        type: 'value', name: '배수',
        nameLocation: 'end', nameRotate: 0, nameGap: 12,
        nameTextStyle: { align: 'left', color: pal.textMuted },
        axisLabel: { color: pal.textMuted, formatter: function (v) { return v + '배'; } },
        splitLine: { lineStyle: { color: pal.border } },
      },
      series: [{
        type: 'bar',
        data: items.map(function (it) { return { value: Number(it.ratio.toFixed(2)), region: it.region }; }),
        itemStyle: {
          color: function (p) { return items[p.dataIndex].region === state.selectedRegion ? pal.accent : pal.primary; },
          borderRadius: [4, 4, 0, 0],
        },
        label: { show: true, position: 'top', color: pal.text, fontSize: 10, formatter: function (p) { return fmtNum(p.value, 1) + '배'; } },
        barMaxWidth: 26,
      }],
    };
    inst.setOption(option, true);
  }

  // ---------- 재가 vs 시설 ----------
  function renderMixArea() {
    var inst = charts.mix;
    if (!inst) return;
    var pal = colors();
    var option = {
      tooltip: {
        trigger: 'axis',
        formatter: function (p) {
          return p[0].axisValue + '년<br>' + p.map(function (s) { return s.seriesName + ' ' + fmtNum(s.value, 1) + '%'; }).join('<br>');
        },
      },
      legend: { data: ['재가급여', '시설급여'], textStyle: { color: pal.text }, top: 0 },
      grid: { left: 46, right: 10, top: 40, bottom: 30, containLabel: true },
      xAxis: {
        type: 'category', data: DATA.mix.map(function (m) { return String(m.year); }),
        axisLabel: { color: pal.textMuted }, axisLine: { lineStyle: { color: pal.border } },
      },
      yAxis: { type: 'value', max: 100, name: '%', axisLabel: { color: pal.textMuted }, splitLine: { lineStyle: { color: pal.border } } },
      series: [
        { name: '재가급여', type: 'line', stack: 'mix', showSymbol: false, itemStyle: { color: pal.primary }, areaStyle: { color: pal.primary }, lineStyle: { color: pal.primary }, data: DATA.mix.map(function (m) { return m.home; }) },
        // pal.grey는 흰 배경에서 거의 안 보여서 시설급여만 별도 색(secondary)을 쓴다
        { name: '시설급여', type: 'line', stack: 'mix', showSymbol: false, itemStyle: { color: pal.secondary }, areaStyle: { color: pal.secondary }, lineStyle: { color: pal.secondary }, data: DATA.mix.map(function (m) { return m.inst; }) },
      ],
    };
    inst.setOption(option, true);
  }

  // ---------- 등급 구성 ----------
  function renderGradeArea() {
    var inst = charts.grade;
    if (!inst) return;
    var pal = colors();
    var option = {
      tooltip: {
        trigger: 'axis',
        formatter: function (p) {
          return p[0].axisValue + '년<br>' + p.map(function (s) { return s.seriesName + ' ' + fmtNum(s.value, 1) + '%'; }).join('<br>');
        },
      },
      legend: { data: ['중증', '경증', '인지지원'], textStyle: { color: pal.text }, top: 0 },
      grid: { left: 46, right: 10, top: 40, bottom: 30, containLabel: true },
      xAxis: {
        type: 'category', data: DATA.mix.map(function (m) { return String(m.year); }),
        axisLabel: { color: pal.textMuted }, axisLine: { lineStyle: { color: pal.border } },
      },
      yAxis: { type: 'value', max: 100, name: '%', axisLabel: { color: pal.textMuted }, splitLine: { lineStyle: { color: pal.border } } },
      series: [
        { name: '중증', type: 'line', stack: 'grade', showSymbol: false, itemStyle: { color: pal.primary }, areaStyle: { color: pal.primary }, lineStyle: { color: pal.primary }, data: DATA.mix.map(function (m) { return m.severe; }) },
        { name: '경증', type: 'line', stack: 'grade', showSymbol: false, itemStyle: { color: pal.accent }, areaStyle: { color: pal.accent }, lineStyle: { color: pal.accent }, data: DATA.mix.map(function (m) { return m.mild; }) },
        // 0.3%라 면적으로는 거의 안 보인다. 범례에서라도 식별되도록 옅은 회색 대신 뚜렷한 색을 쓴다
        { name: '인지지원', type: 'line', stack: 'grade', showSymbol: false, itemStyle: { color: pal.tertiary }, areaStyle: { color: pal.tertiary }, lineStyle: { color: pal.tertiary }, data: DATA.mix.map(function (m) { return m.cognitive; }) },
      ],
    };
    inst.setOption(option, true);
  }

  // ---------- 시도별 재가 비중 이동 (덤벨) ----------
  function renderDumbbell() {
    var inst = charts.dumbbell;
    if (!inst) return;
    var pal = colors();

    var items = REGIONS.map(function (region) {
      var base2010 = byRegionYear.get(region + '__2010');
      var base = (base2010 && base2010.homeShare != null) ? base2010 : byRegionYear.get(region + '__2012');
      var last = byRegionYear.get(region + '__2024');
      if (!base || base.homeShare == null || !last || last.homeShare == null) return null;
      return { region: region, short: regionShort.get(region), start: base.homeShare, end: last.homeShare, baseYear: base.year };
      // 라벨로 찍히는 값이 2024년이므로 정렬도 2024년 기준이어야 눈으로 순위가 읽힌다
    }).filter(Boolean).sort(function (a, b) { return a.end - b.end; });

    var categories = items.map(function (it) { return it.short + (it.baseYear !== 2010 ? '*' : ''); });

    var option = {
      tooltip: {
        trigger: 'item',
        formatter: function (p) {
          var it = items[p.dataIndex];
          if (!it) return '';
          var delta = it.end - it.start;
          return it.short + '<br>' + it.baseYear + '년 ' + fmtNum(it.start, 1) + '% → 2024년 ' + fmtNum(it.end, 1) + '%<br>변화 ' + (delta >= 0 ? '+' : '') + fmtNum(delta, 1) + '%p';
        },
      },
      grid: { left: 56, right: 64, top: 28, bottom: 20, containLabel: true },
      xAxis: {
        type: 'value', name: '재가 비중(%)', min: 0, max: 100,
        nameLocation: 'end', nameRotate: 0, nameGap: 18,
        nameTextStyle: { align: 'right', color: pal.textMuted },
        axisLabel: { color: pal.textMuted }, splitLine: { lineStyle: { color: pal.border } },
      },
      yAxis: { type: 'category', data: categories, axisLabel: { color: pal.text }, axisLine: { lineStyle: { color: pal.border } } },
      series: [{
        type: 'custom',
        clip: true,
        renderItem: function (params, api) {
          var idx = params.dataIndex;
          var it = items[idx];
          var isSel = it.region === state.selectedRegion;
          var p1 = api.coord([it.start, idx]);
          var p2 = api.coord([it.end, idx]);
          return {
            type: 'group',
            children: [
              // 시작점(2010)이 pal.border로 그려지면 사실상 안 보여서 점 하나짜리 차트처럼 보인다 -> textMuted로 대비 확보
              { type: 'line', shape: { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] }, style: { stroke: isSel ? pal.accent : pal.textMuted, lineWidth: isSel ? 3 : 2 } },
              { type: 'circle', shape: { cx: p1[0], cy: p1[1], r: 5 }, style: { fill: isSel ? pal.accent : pal.textMuted } },
              { type: 'circle', shape: { cx: p2[0], cy: p2[1], r: 6 }, style: { fill: isSel ? pal.accent : pal.primary } },
              { type: 'text', style: { text: fmtNum(it.end, 0) + '%', x: p2[0] + 10, y: p2[1], fill: pal.text, fontSize: 10, textVerticalAlign: 'middle' } },
            ],
          };
        },
        data: items.map(function (it, i) { return [it.end, i]; }),
        encode: { x: 0, y: 1 },
      }],
    };
    inst.setOption(option, true);
  }

  // ---------- 뷰포트 진입 시 초기화 ----------
  var pendingCharts = []; // IntersectionObserver가 끝내 발화하지 않을 때(예: 백그라운드 탭) 대비한 목록

  function initChartNow(entry) {
    if (charts[entry.key]) return;
    charts[entry.key] = echarts.init(entry.el);
    if (entry.clickToRegion) {
      charts[entry.key].on('click', function (params) {
        var region = entry.clickToRegion(params);
        if (region) selectRegion(state.selectedRegion === region ? null : region);
      });
    }
    entry.renderFn();
    if (entry.io) entry.io.unobserve(entry.el);
  }

  function registerChart(elId, key, renderFn, clickToRegion) {
    var el = document.getElementById(elId);
    if (!el) return;
    var entry = { el: el, key: key, renderFn: renderFn, clickToRegion: clickToRegion, io: null };
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) initChartNow(entry); });
    }, { threshold: 0.1 });
    entry.io = io;
    io.observe(el);
    pendingCharts.push(entry);
  }

  // 뷰포트 진입 감지가 발화하지 않는 상황(예: 백그라운드 탭에서 로드) 대비 안전장치
  function forceInitPendingCharts() {
    pendingCharts.forEach(function (entry) { if (!charts[entry.key]) initChartNow(entry); });
  }

  // ---------- 결론 ----------
  // 결론 문장의 숫자도 하드코딩하지 않는다. 데이터가 바뀌면 문장도 같이 바뀌어야 한다.
  function buildConclusion() {
    var y0 = DATA.meta.period[0], y1 = DATA.meta.period[1];
    // 인구를 분모로 쓰므로 pop65가 있는 행만 쓴다 (세종 2012 등 결측 제외)
    var a = (byYear.get(y0) || []).filter(function (r) { return r.pop65 != null && r.total != null; });
    var b = (byYear.get(y1) || []).filter(function (r) { return r.pop65 != null && r.total != null; });

    var totRatio = sumField(b, 'total') / sumField(a, 'total');
    var popRatio = sumField(b, 'pop65') / sumField(a, 'pop65');

    // 노인 1인당 급여 = 수급률 × 수급자 1인당 급여.
    // 로그를 씌우면 곱이 합이 되므로, 공분산으로 각 항의 기여도를 나눌 수 있다.
    var rows = b.filter(function (r) { return r.coverage && r.perRecipient && r.perElder; });
    var lp = rows.map(function (r) { return Math.log(r.perElder); });
    var lc = rows.map(function (r) { return Math.log(r.coverage); });
    var lr = rows.map(function (r) { return Math.log(r.perRecipient); });
    var varP = covariance(lp, lp);
    var shareCov = covariance(lc, lp) / varP * 100;

    var covs = rows.map(function (r) { return r.coverage; });
    var pers = rows.map(function (r) { return r.perRecipient; });
    var covLow = Math.min.apply(null, covs), covHigh = Math.max.apply(null, covs);

    var mixNow = DATA.mix[DATA.mix.length - 1], mixThen = DATA.mix[0];

    fill({
      growTotal: fmtNum(totRatio, 2) + '배',
      growPop: fmtNum(popRatio, 2) + '배',
      growPer: fmtNum(totRatio / popRatio, 2) + '배',
      shareCoverage: Math.round(shareCov) + '%',
      shareIntensity: Math.round(100 - shareCov) + '%',
      gapCoverage: fmtNum(covHigh / covLow, 2) + '배',
      gapIntensity: fmtNum(Math.max.apply(null, pers) / Math.min.apply(null, pers), 2) + '배',
      covLow: fmtNum(covLow, 1) + '%',
      covHigh: fmtNum(covHigh, 1) + '%',
      homeNow: fmtNum(mixNow.home, 1) + '%',
      homeThen: fmtNum(mixThen.home, 1) + '%',
      mildNow: fmtNum(mixNow.mild + mixNow.cognitive, 1) + '%',
    });
  }

  function covariance(a, b) {
    var n = a.length;
    var ma = a.reduce(function (s, v) { return s + v; }, 0) / n;
    var mb = b.reduce(function (s, v) { return s + v; }, 0) / n;
    return a.reduce(function (s, v, i) { return s + (v - ma) * (b[i] - mb); }, 0) / (n - 1);
  }

  function fill(map) {
    Object.keys(map).forEach(function (key) {
      document.querySelectorAll('[data-fill="' + key + '"]').forEach(function (el) {
        el.textContent = map[key];
      });
    });
  }

  function registerAllCharts() {
    registerChart('chart-rank', 'rank', renderRankBar, function (p) { return p.data && p.data.region; });
    registerChart('chart-scatter', 'scatter', renderScatter, function (p) { return p.data && p.data.region; });
    registerChart('chart-trend', 'trend', renderTrendArea);
    registerChart('chart-trajectory', 'trajectory', renderTrajectory);
    registerChart('chart-growth', 'growth', renderGrowthBar, function (p) { return p.data && p.data.region; });
    registerChart('chart-mix', 'mix', renderMixArea);
    registerChart('chart-grade', 'grade', renderGradeArea);
    registerChart('chart-dumbbell', 'dumbbell', renderDumbbell);
  }

  // ---------- 리사이즈 / 다크모드 전환 ----------
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      Object.keys(charts).forEach(function (k) { if (charts[k]) charts[k].resize(); });
    }, 150);
  }

  function onThemeChange() {
    renderCartogram();
    renderRankBar(); renderScatter(); renderTrendArea(); renderTrajectory();
    renderGrowthBar(); renderMixArea(); renderGradeArea(); renderDumbbell();
  }

  // ---------- 초기화 ----------
  async function init() {
    try {
      var res = await fetch('./data.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      DATA = await res.json();
    } catch (err) {
      showFatalError(err);
      return;
    }

    buildIndexes();
    buildKPI();
    buildConclusion();
    buildControls();
    initCartogram();
    registerAllCharts();
    setTimeout(forceInitPendingCharts, 2000);

    window.addEventListener('resize', onResize);
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', onThemeChange);
    else if (mq.addListener) mq.addListener(onThemeChange); // 구형 브라우저 대응

    var footerEl = document.getElementById('footer-source');
    footerEl.textContent = '출처: ' + DATA.meta.source + ' · 기간 ' + DATA.meta.period[0] + '~' + DATA.meta.period[1] + '년 · ' + DATA.meta.priceBase + ' · ' + DATA.meta.unitNote;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
