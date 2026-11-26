// The homepage's motion. Nothing here sends or stores anything: it reveals
// sections as they arrive, runs the globe, steps through How it works, lets
// you answer a question, and lets the globe and buttons follow the cursor a little.
// With reduced motion, everything holds still except what you click.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** A loop that runs only while `step` says something is still moving. */
function animator(step) {
  let raf = 0;
  let last = 0;
  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    raf = step(dt) ? requestAnimationFrame(tick) : 0;
  };
  return () => {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };
}

/**
 * Swap an element's text: the old words fade up and away, the new ones rise in.
 * A newer swap on the same element wins, even mid-animation. Every animation
 * is cleared once it has done its job, so nothing is ever left holding the
 * text invisible.
 */
const swaps = new WeakMap();
async function swapText(el, text, delay = 0) {
  const prev = swaps.get(el);
  if ((prev ? prev.text : el.textContent) === text) return;
  // Carry on from wherever a cut-short swap had got to, so nothing flashes.
  const from = prev ? Number(getComputedStyle(el).opacity) : 1;
  prev?.anims.forEach((a) => a.cancel());
  const job = { text, anims: [] };
  swaps.set(el, job);
  if (reduced) {
    el.textContent = text;
    return;
  }
  const out = el.animate(
    [
      { opacity: from, translate: '0 0' },
      { opacity: 0, translate: '0 -0.35em' },
    ],
    { duration: 220, delay, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' },
  );
  job.anims.push(out);
  try {
    await out.finished;
  } catch {
    return; // cancelled by a newer swap
  }
  if (swaps.get(el) !== job) return;
  el.textContent = text;
  const rise = el.animate(
    [
      { opacity: 0, translate: '0 0.4em' },
      { opacity: 1, translate: '0 0' },
    ],
    { duration: 480, easing: EASE_OUT },
  );
  job.anims.push(rise);
  // In the same frame: drop the held "faded out" state; the rise covers it from here.
  out.cancel();
  rise.finished.then(() => {
    if (swaps.get(el) === job) swaps.delete(el);
  }, () => {});
}

/* Header ------------------------------------------------------------------ */

// It turns into a glass bar once the page scrolls, light over paper sections and dark over the sea.
const top = $('[data-top]');
const darkSections = $$('[data-dark]');
const onScrollHeader = () => {
  if (!top) return;
  top.classList.toggle('is-scrolled', window.scrollY > 24);
  const y = 44;
  const overDark = darkSections.some((s) => {
    const r = s.getBoundingClientRect();
    return r.top <= y && r.bottom >= y;
  });
  top.classList.toggle('on-light', !overDark);
};
window.addEventListener('scroll', onScrollHeader, { passive: true });
window.addEventListener('resize', onScrollHeader);
onScrollHeader();

const menu = $('.menu');
if (menu) {
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) menu.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.open) {
      menu.open = false;
      $('summary', menu).focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
}

/* Entrances --------------------------------------------------------------- */

const reveal = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      reveal.unobserve(e.target);
    }
  },
  { rootMargin: '0px 0px -10% 0px', threshold: 0.12 },
);
for (const el of $$('[data-reveal]')) {
  // Siblings arrive one after another.
  const kin = [...el.parentElement.children].filter((c) => c.hasAttribute('data-reveal'));
  el.style.setProperty('--d', `${kin.indexOf(el) * 0.09}s`);
  reveal.observe(el);
}

/* Hero: the globe and the gate card ------------------------------------------ */

const hero = $('[data-hero]');
let heroVisible = true;
if (hero) {
  new IntersectionObserver(([e]) => (heroVisible = e.isIntersecting)).observe(hero);

  const globeRoot = $('[data-globe] .globe', hero);
  if (globeRoot) {
    import('./globe.js')
      .then(({ startGlobe }) => startGlobe({ root: globeRoot, area: hero, reduced }))
      .catch(() => globeRoot.classList.add('no-gl'));
  }

  const gate = $('[data-gate]', hero);
  if (gate && !reduced) {
    const GATES = [
      { name: 'YouTube', domain: 'youtube.com', task: 'Find 10 countries in Europe' },
      { name: 'Instagram', domain: 'instagram.com', task: 'Get 8 questions right' },
      { name: 'TikTok', domain: 'tiktok.com', task: 'Find 10 countries in Africa' },
      { name: 'Reddit', domain: 'reddit.com', task: 'Get 8 questions right' },
      { name: 'X', domain: 'x.com', task: 'Find 10 countries in Asia' },
    ];
    const domain = $('[data-gate-domain]', gate);
    const title = $('[data-gate-title]', gate);
    const lede = $('[data-gate-lede]', gate);
    let i = 0;
    setInterval(() => {
      if (!heroVisible || document.hidden) return;
      i = (i + 1) % GATES.length;
      const g = GATES[i];
      swapText(domain, g.domain);
      swapText(title, `${g.name} is locked.`, 60);
      swapText(lede, `${g.task} and ${g.name} opens for 10 minutes.`, 120);
    }, 5200);
  }
}

/* How it works ------------------------------------------------------------- */

const stepsRoot = $('[data-steps]');
if (stepsRoot) {
  const steps = $$('.step', stepsRoot);
  const nodes = steps.map((s) => $('.step__node', s));
  const rail = $('.steps__rail', stepsRoot);
  const fill = $('[data-rail]', stepsRoot);
  const stage = $('.how__stage');
  const browser = $('.browser', stage);
  const screens = Object.fromEntries($$('[data-screen]', stage).map((s) => [s.dataset.screen, s]));
  const address = $('[data-address]', stage);
  const callout = $('[data-callout]', stage);
  const badges = $$('[data-badge]');
  const stageBadge = $('[data-badge]', stage);

  let active = -1;
  let alternate = 0;
  let countdown = 0;

  const show = (key) => {
    for (const [k, el] of Object.entries(screens)) el.classList.toggle('is-on', k === key);
  };

  // The badge counts down the way the extension's does: "10m", then minutes and seconds under ten minutes.
  const clock = (s) => (s >= 600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  const startCountdown = () => {
    clearInterval(countdown);
    let left = 600;
    for (const b of badges) b.textContent = clock(left);
    countdown = setInterval(() => {
      left = Math.max(0, left - 1);
      for (const b of badges) b.textContent = clock(left);
    }, 1000);
  };

  const setActive = (i) => {
    if (i === active) return;
    active = i;
    steps.forEach((s, k) => {
      s.classList.toggle('is-active', k === i);
      s.classList.toggle('is-past', k < i);
    });
    clearInterval(alternate);
    clearInterval(countdown);
    stageBadge?.classList.toggle('is-on', i === 2);
    callout?.classList.toggle('is-on', i === 2);
    if (i === 0) {
      show('0');
      swapText(address, 'youtube.com');
    } else if (i === 1) {
      // Map or questions: QuizBlock picks, so the browser shows both in turn.
      show('1');
      swapText(address, 'youtube.com');
      let quiz = false;
      if (!reduced)
        alternate = setInterval(() => {
          quiz = !quiz;
          show(quiz ? '1b' : '1');
          swapText(address, quiz ? 'reddit.com' : 'youtube.com');
        }, 3200);
    } else if (i === 2) {
      show('2');
      swapText(address, 'youtube.com');
      startCountdown();
    } else {
      show('3');
      swapText(address, 'QuizBlock dashboard');
    }
  };

  // The rail runs from the first step's dot to the last one's, and fills as you read.
  const placeRail = () => {
    const base = stepsRoot.getBoundingClientRect().top;
    const first = nodes[0].getBoundingClientRect();
    const last = nodes[nodes.length - 1].getBoundingClientRect();
    rail.style.top = `${first.top + first.height / 2 - base}px`;
    rail.style.bottom = `${stepsRoot.offsetHeight - (last.top + last.height / 2 - base)}px`;
    if (browser && stage) stage.style.setProperty('--half', `${browser.offsetHeight / 2}px`);
  };

  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const mid = window.innerHeight * 0.55;
      const r = rail.getBoundingClientRect();
      fill.style.setProperty('--p', clamp((window.innerHeight * 0.5 - r.top) / Math.max(1, r.height), 0, 1).toFixed(4));
      let i = 0;
      nodes.forEach((n, k) => {
        if (n.getBoundingClientRect().top < mid) i = k;
      });
      setActive(i);
    });
  };
  placeRail();
  new ResizeObserver(() => {
    placeRail();
    onScroll();
  }).observe(stepsRoot);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();

}

/* Magnetic buttons: they drift a few pixels towards the cursor. ------------- */

if (fine && !reduced) {
  for (const el of $$('[data-magnetic]')) {
    const inner = el.firstElementChild;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const nx = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2), -1, 1);
      const ny = clamp((e.clientY - (r.top + r.height / 2)) / (r.height / 2), -1, 1);
      el.classList.add('is-magnet');
      el.style.translate = `${Math.round(nx * 5)}px ${Math.round(ny * 3)}px`;
      if (inner) inner.style.translate = `${Math.round(nx * 2)}px ${Math.round(ny * 1.5)}px`;
    });
    el.addEventListener('pointerleave', () => {
      el.classList.remove('is-magnet');
      el.style.translate = '';
      if (inner) inner.style.translate = '';
    });
  }
}

/* A question to try: from the extension's question bank, word for word. ----- */

const CARDS = [
  { subject: 'Nature', plate: 'var(--mint)', q: 'What colour is a polar bear’s skin?', options: ['Pink', 'Black', 'White', 'Grey'], answer: 1, fact: 'Its fur isn’t really white either: each hair is transparent and looks white because it scatters light, much as snow does.' },
  { subject: 'Language', plate: 'var(--peach)', q: 'The word “quarantine” comes from the Italian for how many days?', options: ['Fourteen', 'Thirty', 'Forty', 'Ten'], answer: 2, fact: 'Ragusa (now Dubrovnik) began isolating ships from plague areas for 30 days in 1377. The wait was later stretched to “quaranta giorni” — forty days.' },
  { subject: 'Geography', plate: 'var(--sage)', q: 'Victoria Falls is on which river?', options: ['Limpopo', 'Congo', 'Zambezi', 'Orange'], answer: 2, fact: 'Its local name, Mosi-oa-Tunya, means “the smoke that thunders” — the spray can be seen from many kilometres away.' },
  { subject: 'Music', plate: 'var(--plum)', q: 'Who composed The Four Seasons?', options: ['Arcangelo Corelli', 'Antonio Vivaldi', 'Johann Sebastian Bach', 'George Frideric Handel'], answer: 1, fact: 'The four violin concertos were published in 1725 with sonnets — possibly by Vivaldi himself — describing the scenes the music paints.' },
  { subject: 'Science', plate: 'var(--sky)', q: 'Why does water boil at a lower temperature high up a mountain?', options: ['Colder air', 'Less oxygen', 'Stronger sunlight', 'Lower air pressure'], answer: 3, fact: 'With less air pressing down, water molecules escape more easily. On the summit of Everest, water boils at only about 70 °C.' },
  { subject: 'Art', plate: 'var(--clay)', q: 'In which city can you see Leonardo da Vinci’s The Last Supper?', options: ['Florence', 'Rome', 'Milan', 'Venice'], answer: 2, fact: 'It covers a wall of the refectory of Santa Maria delle Grazie. Leonardo painted on dry plaster instead of true fresco, so it began flaking within decades.' },
  { subject: 'Sport', plate: 'var(--sand)', q: 'In tennis scoring, what does “love” mean?', options: ['A tied game', 'Zero', 'A winning serve', 'Match point'], answer: 1, fact: 'One popular but unproven theory links it to the French l’œuf, “the egg”, for the shape of a zero.' },
  { subject: 'History', plate: 'var(--butter)', q: 'Along which river did ancient Egyptian civilisation grow up?', options: ['Tigris', 'Euphrates', 'Indus', 'Nile'], answer: 3, fact: 'The yearly flood left fertile black silt on the fields. Egyptians called their country Kemet, “the black land”, after it.' },
];

const stack = $('[data-deck]');
const card = $('[data-card]');
if (stack && card) {
  let index = 0;
  let answered = false;
  const subject = $('.card__subject', card);
  const question = $('.card__q', card);
  const options = $('.card__options', card);
  const result = $('.card__result', card);

  /** Change the deck's contents, gliding its height from before to after. */
  const resize = (change, duration = 520) => {
    const before = stack.offsetHeight;
    change();
    const after = stack.offsetHeight;
    if (!reduced && before !== after) stack.animate({ height: [`${before}px`, `${after}px`] }, { duration, easing: EASE_OUT });
  };

  const wire = () => {
    $$('.opt', options).forEach((btn, k) => btn.addEventListener('click', () => choose(k)));
  };

  const fillCard = (c) => {
    subject.innerHTML = '';
    const dot = document.createElement('i');
    dot.style.setProperty('--plate', c.plate);
    const name = document.createElement('span');
    name.textContent = c.subject;
    subject.append(dot, name);
    question.textContent = c.q;
    options.innerHTML = '';
    for (const o of c.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.textContent = o;
      options.append(b);
    }
    result.innerHTML = '';
    wire();
  };

  const choose = (k) => {
    if (answered) return;
    answered = true;
    const c = CARDS[index];
    const right = k === c.answer;
    $$('.opt', options).forEach((b, j) => {
      b.disabled = true;
      if (j === c.answer) b.classList.add('is-right');
      else if (j === k) b.classList.add('is-wrong');
      else b.classList.add('is-dim');
    });
    const box = document.createElement('div');
    box.className = `result ${right ? 'result--right' : 'result--wrong'}`;
    const head = document.createElement('p');
    head.className = 'result__head';
    head.textContent = right ? 'Correct.' : `Not quite. It’s ${c.options[c.answer]}.`;
    const fact = document.createElement('p');
    fact.textContent = c.fact;
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'next';
    next.textContent = 'Next question';
    next.addEventListener('click', advance);
    box.append(head, fact, next);
    resize(() => result.append(box));
    if (!reduced)
      box.animate(
        [
          { opacity: 0, translate: '0 10px' },
          { opacity: 1, translate: '0 0' },
        ],
        { duration: 520, delay: 80, easing: EASE_OUT, fill: 'backwards' },
      );
    next.focus({ preventScroll: true });
  };

  let busy = false;
  const advance = async (e) => {
    if (busy) return;
    busy = true;
    const byKeyboard = e && e.detail === 0;
    index = (index + 1) % CARDS.length;
    if (!reduced) {
      await card.animate(
        [
          { opacity: 1, translate: '0 0', rotate: '0deg' },
          { opacity: 0, translate: '-28px -6px', rotate: '-2.5deg' },
        ],
        { duration: 260, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' },
      ).finished;
    }
    answered = false;
    resize(() => fillCard(CARDS[index]), 560);
    if (!reduced) {
      card.animate(
        [
          { opacity: 0, translate: '0 18px', scale: 0.96, rotate: '0deg' },
          { opacity: 1, translate: '0 0', scale: 1, rotate: '0deg' },
        ],
        { duration: 620, easing: EASE_OUT, fill: 'forwards' },
      );
    }
    if (byKeyboard) $('.opt', options)?.focus({ preventScroll: true });
    busy = false;
  };

  wire();
}
