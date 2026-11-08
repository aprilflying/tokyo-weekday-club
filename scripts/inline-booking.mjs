// Injected into the original site's booking component during its existing build.
// Both booking modes share the same parent/child form and review panel.
export const INLINE_BOOKING_METHODS = String.raw`
  startInlineBooking() {
    this._refreshAvailability = () => this.refreshBookingAvailability();
    window.addEventListener('focus', this._refreshAvailability);
    this.refreshBookingAvailability();
  }
  stopInlineBooking() {
    if (this._refreshAvailability) window.removeEventListener('focus', this._refreshAvailability);
  }
  async refreshBookingAvailability() {
    try {
      const response = await fetch('/api/availability?_=' + Date.now(), { cache: 'no-store' });
      const counts = await response.json();
      if (!response.ok || counts.bookingVersion !== 9 || !counts.sessions) throw new Error('availability');
      this.setState({ counts, availabilityError: false });
    } catch (_) { this.setState({ counts: null, availabilityError: true }); }
  }
  dayDate(i, d = 0) {
    return new Date(Date.parse('2026-10-05T00:00:00Z') + (i * 7 + d) * 86400000).toISOString().slice(0, 10);
  }
  dayLabel(date, lang) {
    return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-Hant' : 'en-GB', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T00:00:00Z'));
  }
  daySession(date, session) {
    const counts = this.state.counts;
    const code = 'D' + date.replace(/-/g, '') + session.toUpperCase();
    const ready = counts && counts.bookingVersion === 9 && counts.sessions;
    const confirmed = counts?.classes?.[code] === 'confirmed';
    const deadline = Date.parse(date + (session === 'am' ? 'T09:00:00+09:00' : 'T14:00:00+09:00')) - 14 * 86400000;
    const closed = Date.now() >= Date.parse(date + 'T00:00:00+09:00') || (Date.now() >= deadline && !confirmed);
    const room = 6 - Number(counts?.sessions?.[code] || 0);
    return { ready: !!ready, confirmed, closed, room, available: !!ready && !closed && room >= (this.state.kids ?? 1) };
  }
  dailyChoices() {
    return Object.entries(this.state.daySels || {}).sort(([a], [b]) => a.localeCompare(b)).map(([date, s]) => ({ date, s }));
  }
  submitDailyBooking(event) {
    event.preventDefault();
    const choices = this.dailyChoices();
    const lang = this.state.lang ?? this.props.lang ?? 'en';
    if (!choices.length || choices.some(d => !this.daySession(d.date, d.s).available)) {
      this.setState({ noWeeks: true, holdError: lang === 'zh' ? '請選擇有名額的日期及時段。' : 'Please choose available dates and sessions.' }); return;
    }
    const form = new FormData(event.target);
    if (form.get('terms') !== 'yes') return;
    const first = form.getAll('kidfirst'), last = form.getAll('kidlast'), ages = form.getAll('kidage');
    const names = first.map((f, i) => (lang === 'zh' ? (last[i] || '') + f : f + ' ' + (last[i] || '')).trim());
    const booking = {
      bookingType: 'day', daysSel: choices, weeksSel: [],
      ref: 'TWC-' + (window.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)),
      name: (lang === 'zh' ? String(form.get('lastname') || '') + String(form.get('firstname') || '') : String(form.get('firstname') || '') + ' ' + String(form.get('lastname') || '')).trim(),
      email: form.get('email') || '',
      whatsapp: ((form.get('dial') === 'other' ? form.get('dialother') : form.get('dial')) || '') + ' ' + (form.get('whatsapp') || ''),
      kids: names.map((n, i) => n + ' (' + ages[i] + ')').join(', '), kidsCount: names.length,
      lang, website: form.get('website') || '', terms: 'yes', referral: (form.get('referral') || '').trim()
    };
    this.setState({ sent: true, booking, holdError: '', noWeeks: false });
    try { window.posthog?.capture('booking_submitted', { booking_type: 'day', days: choices.length, lang }); } catch (_) {}
  }
  renderVals() {
    const v = this.weeklyRenderVals();
    const single = this.state.bookingType === 'day', lang = v.zh ? 'zh' : 'en';
    const text = (en, zh) => v.zh ? zh : en;
    const kids = this.state.kids ?? 1;
    const choices = this.dailyChoices();
    const options = Array.from({ length: 12 }, (_, i) => ({ value: String(i), label: this.dayLabel(this.dayDate(i), lang) + ' – ' + this.dayLabel(this.dayDate(i, 3), lang) }))
      .filter(w => Date.now() < Date.parse(this.dayDate(Number(w.value), 3) + 'T00:00:00+09:00'));
    const firstAvailable = options.find(w => [0, 1, 2, 3].some(d => ['am', 'pm'].some(s => this.daySession(this.dayDate(Number(w.value), d), s).available)));
    const week = options.some(w => w.value === this.state.dayWeek) ? this.state.dayWeek : (firstAvailable || options[0])?.value;
    const dayRows = week === undefined ? [] : [0, 1, 2, 3].map(d => {
      const date = this.dayDate(Number(week), d), title = this.dayLabel(date, lang);
      return { title, sessions: ['am', 'pm'].map(s => {
        const status = this.daySession(date, s), selected = this.state.daySels?.[date] === s;
        const time = s === 'am' ? '09:00–12:00' : '14:00–17:00';
        const hint = !status.ready ? text('Loading…', '載入中…') : status.closed ? text('Closed', '已截止') : !status.available ? text('Not enough places', '名額不足') : status.confirmed ? text('Confirmed', '已確認') : text('Pending confirmation', '待開班');
        return { time, hint, selected, disabled: !status.available, label: title + ' ' + time + ' · ' + hint,
          bg: selected ? '#0F0F12' : '#FAF7F2', fg: selected ? '#FAF7F2' : '#0F0F12', opacity: status.available ? 1 : 0.45,
          pick: () => { if (!this.daySession(date, s).available) return; this.trackStart(); this.setState(st => { const next = { ...st.daySels }; if (next[date] === s) delete next[date]; else next[date] = s; return { daySels: next, holdError: '', noWeeks: false }; }); }
        };
      }) };
    });
    const datesText = choices.map(d => this.dayLabel(d.date, lang) + ' · ' + (d.s === 'am' ? '09:00–12:00' : '14:00–17:00')).join(' / ');
    const amount = (single ? choices.length * 14000 : Object.keys(this.state.sels || {}).length * 48000) * kids;
    const total = '¥' + amount.toLocaleString('en-US');
    const groups = {};
    choices.forEach(d => { const key = Math.floor((Date.parse(d.date) - Date.parse('2026-10-05')) / (7 * 86400000)) + d.s; groups[key] = (groups[key] || 0) + 1; });
    Object.assign(v, {
      isSingleDay: single, isWeekly: !single,
      formDisplay: this.state.sent ? 'none' : 'block',
      dayModeBg: single ? '#FAF7F2' : 'transparent', dayModeFg: single ? '#C0392B' : '#FAF7F2',
      weekModeBg: !single ? '#FAF7F2' : 'transparent', weekModeFg: !single ? '#C0392B' : '#FAF7F2',
      chooseSingleDay: () => this.setState({ bookingType: 'day', sels: {}, sent: false, noWeeks: false, holdError: '' }),
      chooseWholeWeek: () => this.setState({ bookingType: 'week', daySels: {}, sent: false, noWeeks: false, holdError: '' }),
      dayWeek: week ?? '', dayWeeks: options, noDayWeeks: !options.length, dayRows,
      changeDayWeek: e => this.setState({ dayWeek: e.target.value }),
      chosenDays: choices.map(d => ({ label: this.dayLabel(d.date, lang) + ' · ' + (d.s === 'am' ? '09:00–12:00' : '14:00–17:00'), remove: () => this.setState(st => { const next = { ...st.daySels }; delete next[d.date]; return { daySels: next }; }) })),
      availabilityMessage: this.state.availabilityError ? text('Availability could not be loaded. Refresh this page or contact us.', '暫時未能載入名額，請重新整理網頁或聯絡我們。') : !this.state.counts ? text('Loading availability…', '正在載入名額…') : '',
      formTotal: total,
      formBreakdown: single ? text(choices.length + ' day(s) × ' + kids + ' child(ren) × ¥14,000', choices.length + ' 日 × ' + kids + ' 位 × ¥14,000') : text(Object.keys(this.state.sels || {}).length + ' week(s) × ' + kids + ' child(ren) × ¥48,000', Object.keys(this.state.sels || {}).length + ' 週 × ' + kids + ' 位 × ¥48,000'),
      weekSaving: single && Object.values(groups).some(n => n === 4),
      reviewPolicy: single ? text('Each selected session is charged only after confirmation with at least 3 children, at least 14 days ahead. Confirmed classes may be charged immediately. No charge for classes that do not run.', '所選每節須於上課前最少 14 日滿 3 人確認開班後才收費。已確認班可隨即扣款；未能開班不收費。') : text('A weekly booking is charged only after all four days are confirmed with at least 3 children, at least 14 days ahead. Confirmed classes may be charged immediately. No charge for classes that do not run.', '整週須四日均於上課前最少 14 日滿 3 人確認後才收費。已確認班可隨即扣款；未能開班不收費。')
    });
    if (single) {
      v.selDays = choices.length ? choices.length + (choices.length === 1 ? ' day' : ' days') : 'a day';
      v.selDaysZh = choices.length ? choices.length + ' 日' : '日期';
      v.submit = e => this.submitDailyBooking(e);
      v.submitDisabled = !this.state.termsOk || !choices.length || choices.some(d => !this.daySession(d.date, d.s).available);
      v.submitOp = v.submitDisabled ? 0.5 : 1;
      v.submitCursor = v.submitDisabled ? 'not-allowed' : 'pointer';
      v.noWeeks = !!this.state.noWeeks && !choices.length;
      const b = this.state.booking || {};
      v.bkRows = [
        { k: text('dates & times', '日期及時段'), v: datesText || '—' },
        { k: text('kids', '小朋友'), v: b.kids || '—' },
        { k: text('total', '費用'), v: total + text(' · charged after confirmation', ' · 確認開班後才收費') },
        { k: text('parent', '家長'), v: b.name || '—' },
        { k: text('contact', '聯絡資料'), v: [b.email, b.whatsapp].filter(Boolean).join(' · ') || '—' }
      ];
      v.payLabel = this.state.holding ? text('Opening secure page…', '正在開啟安全頁面…') : text('Save my card · ' + total + ' after confirmation →', '儲存信用卡 · 確認後收取 ' + total + ' →');
    }
    const pay = v.pay;
    v.pay = e => {
      const b = this.state.booking;
      if (b?.bookingType === 'day' && (!b.daysSel?.length || b.daysSel.some(d => !this.daySession(d.date, d.s).available))) {
        e?.preventDefault?.(); this.setState({ sent: false, holding: false, holdError: text('A selected session is no longer available. Please review your dates.', '部分所選時段已截止或額滿，請重新核對日期。') }); return;
      }
      return pay(e);
    };
    return v;
  }
`;
