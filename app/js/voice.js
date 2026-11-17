// Voice input for place fields. Uses the browser SpeechRecognition API
// (zh-CN). Recognition availability and accuracy are controlled by the browser,
// not by this app; when it is unavailable the field stays fully usable by typing.

import { toast } from './help.js';
import { escapeHtml } from './format.js';

const ALIASES = [
  ['华东交大', '华东交通大学'],
  ['华交', '华东交通大学'],
  ['交大', '华东交通大学'],
  ['南昌西站', '南昌西站'],
  ['西站', '南昌西站'],
  ['南昌火车站', '南昌火车站'],
  ['火车站', '南昌火车站'],
  ['昌北机场', '昌北机场'],
  ['机场', '昌北机场'],
  ['八一广场', '八一广场'],
  ['八一', '八一广场'],
  ['秋水广场', '秋水广场'],
  ['秋水', '秋水广场'],
  ['双港', '双港'],
  ['地铁大厦', '地铁大厦'],
];

const SpeechRecognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

export function speechSupported() {
  return !!SpeechRecognition;
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s·,，。.!！?？、:：;；()（）\-_/\\|]/g, '')
    .replace(/请问|帮我|我要|我想|导航到|带我去|去往|前往/g, '');
}

function bigrams(text) {
  const out = [];
  for (let i = 0; i < text.length - 1; i += 1) out.push(text.slice(i, i + 2));
  return out;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b)) return 80 + Math.min(12, b.length);
  if (b.includes(a)) return 70 + Math.min(12, a.length);
  const ga = bigrams(a);
  const gb = new Set(bigrams(b));
  if (!ga.length || !gb.size) return 0;
  const hits = ga.filter((g) => gb.has(g)).length;
  return (hits / Math.max(ga.length, gb.size)) * 60;
}

function expand(transcript) {
  let text = normalize(transcript);
  for (const [alias, full] of ALIASES) {
    if (text.includes(full)) continue;
    text = text.split(alias).join(full);
  }
  return text;
}

export function matchOption(options, transcript) {
  const text = expand(transcript);
  if (!text) return null;
  let best = null;
  for (const option of options) {
    const label = typeof option === 'string' ? option : option.label;
    const value = typeof option === 'string' ? option : option.value;
    const score = Math.max(
      similarity(normalize(label), text),
      similarity(normalize(String(value || '')), text),
    );
    if (!best || score > best.score) best = { label, value, score };
  }
  return best && best.score >= 26 ? best : null;
}

function optionsOf(element) {
  if (element.tagName === 'SELECT') {
    return Array.from(element.options).map((option) => ({
      label: option.textContent,
      value: option.value,
      disabled: option.disabled,
    })).filter((option) => !option.disabled && option.value !== '');
  }
  if (element.list) {
    return Array.from(element.list.options).map((option) => ({ label: option.value, value: option.value }));
  }
  return [];
}

function fieldWrapper(element) {
  return element.closest('.field') || element.parentElement;
}

function applyChoice(element, choice) {
  if (element.tagName === 'SELECT') {
    const option = Array.from(element.options).find((item) => item.value === choice.value);
    if (!option) return false;
    element.value = option.value;
  } else {
    element.value = choice.value ?? choice.label;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function pairTranscript(element, transcript) {
  if (!/^(origin|destination)/i.test(element.id || '')) return transcript;
  const match = String(transcript).match(/从(.+?)(?:到|去|至)(.+)/);
  if (!match) return transcript;
  return /origin/i.test(element.id) ? match[1] : match[2];
}

function markListening(button, listening) {
  button.classList.toggle('listening', listening);
  button.setAttribute('aria-pressed', listening ? 'true' : 'false');
  const hint = button.querySelector('.voice-hint');
  if (hint) hint.textContent = listening ? '正在听…' : '语音输入';
}

export function enhanceVoice(root = document) {
  const elements = root.querySelectorAll('[data-voice]');
  for (const element of elements) {
    if (element.dataset.voiceBound === '1') continue;
    element.dataset.voiceBound = '1';
    const wrapper = fieldWrapper(element);
    if (!wrapper) continue;
    wrapper.classList.add('voice-field');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'voice-btn';
    button.setAttribute('aria-label', `语音输入${element.dataset.voiceLabel || ''}`);
    button.setAttribute('aria-pressed', 'false');
    button.title = speechSupported() ? '点击后说出地点名称' : '当前浏览器不支持语音识别';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg><span class="voice-hint">语音</span>';
    wrapper.appendChild(button);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      startListening(element, button);
    });
  }
}

function startListening(element, button) {
  if (!SpeechRecognition) {
    toast('当前浏览器不支持语音识别，请用 Edge / Chrome，或直接输入。');
    return;
  }
  if (button.dataset.busy === '1') {
    button.dataset.busy = '0';
    button._recognition?.stop();
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = false;
  recognition.maxAlternatives = 4;
  recognition.continuous = false;
  button._recognition = recognition;
  button.dataset.busy = '1';
  markListening(button, true);
  let finished = false;

  recognition.onresult = (event) => {
    const alternatives = [];
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      for (let j = 0; j < event.results[i].length; j += 1) alternatives.push(event.results[i][j].transcript);
    }
    const transcript = alternatives.join(' ').trim();
    const fieldText = pairTranscript(element, transcript);
    const options = optionsOf(element);
    if (!options.length) {
      element.value = fieldText;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      toast(`语音已填入：${fieldText}`);
      return;
    }
    const match = matchOption(options, fieldText);
    if (!match) {
      toast(`听到“${transcript}”，但没有匹配到地点，请再说一次或手动选择。`);
      return;
    }
    if (applyChoice(element, match)) toast(`语音识别：${match.label}`);
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      toast('麦克风未授权。请在浏览器地址栏允许麦克风，或继续手动输入。');
    } else if (event.error === 'no-speech') {
      toast('没有听到语音，请靠近麦克风再试。');
    } else if (event.error === 'network') {
      toast('浏览器的语音服务当前不可用（可能离线）；可继续手动输入。');
    } else if (event.error !== 'aborted') {
      toast('语音识别未完成，请重试或手动输入。');
    }
  };

  recognition.onend = () => {
    if (finished) return;
    finished = true;
    delete button.dataset.busy;
    markListening(button, false);
  };

  try {
    recognition.start();
  } catch (error) {
    delete button.dataset.busy;
    markListening(button, false);
    toast('无法启动语音识别，请稍后再试。');
  }
}

/* ---------------- 对话式语音助手 ---------------- */

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNumber(text) {
  const value = String(text || '').trim();
  if (/^\d+$/.test(value)) return Number(value);
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [tens, units] = value.split('十');
    return (tens ? CN_DIGIT[tens] ?? 0 : 1) * 10 + (units ? CN_DIGIT[units] ?? 0 : 0);
  }
  let number = 0;
  for (const char of value) number = number * 10 + (CN_DIGIT[char] ?? 0);
  return number;
}

function parseDeadline(text) {
  const match24 = String(text).match(/(\d{1,2})[:：](\d{2})/);
  if (match24) {
    const hour = Number(match24[1]);
    const minute = Number(match24[2]);
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }
  const match = String(text).match(/(上午|中午|下午|傍晚|晚上)?\s*([零一二三四五六七八九十两\d]{1,3})\s*[点点时]\s*(半|一刻|三刻|[零一二三四五六七八九十两\d]{1,3}分?)?/);
  if (!match) return null;
  let hour = cnNumber(match[2]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 24) return null;
  let minute = 0;
  const tail = match[3] || '';
  if (tail === '半') minute = 30;
  else if (tail === '一刻') minute = 15;
  else if (tail === '三刻') minute = 45;
  else if (tail) minute = cnNumber(tail.replace('分', '')) || 0;
  const period = match[1] || '';
  if (/下午|傍晚|晚上/.test(period) && hour < 12) hour += 12;
  if (/中午/.test(period) && hour < 11) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parsePreference(text) {
  if (/最快|赶时间|着急|时间紧/.test(text)) return { key: 'fastest', label: '最快' };
  if (/少走|不想走|少步行|腿脚/.test(text)) return { key: 'lowwalk', label: '少步行' };
  if (/最稳|稳妥|不迟到|保险|可靠/.test(text)) return { key: 'balanced', label: '最稳' };
  return null;
}

function placesInText(text, places) {
  const normalized = expand(text);
  const found = [];
  for (const place of places) {
    const names = [place.name];
    for (const [alias, full] of ALIASES) {
      if (full === place.name) names.push(alias);
    }
    let best = null;
    for (const name of names) {
      const key = normalize(name);
      if (!key) continue;
      const index = normalized.indexOf(key);
      if (index >= 0 && (!best || key.length > best.length)) best = { place, index, length: key.length };
    }
    if (best) found.push(best);
  }
  found.sort((a, b) => a.index - b.index || b.length - a.length);
  const output = [];
  for (const item of found) {
    if (output.some((entry) => entry.place.id === item.place.id)) continue;
    if (output.some((entry) => entry.index === item.index && entry.length > item.length)) continue;
    output.push(item);
  }
  return output.map((item) => item.place);
}

function matchPlaceChunk(chunk, places) {
  if (!chunk) return null;
  const direct = placesInText(chunk, places);
  if (direct.length) return direct[0];
  const match = matchOption(places.map((place) => ({ label: place.name, value: place.id })), chunk);
  if (!match) return null;
  return places.find((place) => place.id === match.value) || null;
}

export function parseTravelUtterance(text, places) {
  const transcript = String(text || '').trim();
  if (!transcript) return null;
  const deadlineText = parseDeadline(transcript);
  const preference = parsePreference(transcript);
  const found = placesInText(transcript, places);
  let origin = null;
  let destination = null;
  const pair = transcript.match(/从(.{2,24}?)(?:到|去|至|往)(.{2,24})/);
  if (pair) {
    origin = matchPlaceChunk(pair[1], places);
    destination = matchPlaceChunk(pair[2], places);
  }
  if (!destination) {
    const target = transcript.match(/(?:去|到|至|往|导航到|带我去|我想去|我要去)(.{2,24})/);
    destination = target ? matchPlaceChunk(target[1], places) : null;
  }
  if (!origin) {
    const start = transcript.match(/(?:从|起点是|出发地是|我在)(.{2,24}?)(?:出发|到|去|至|往|，|,|$)/);
    origin = start ? matchPlaceChunk(start[1], places) : null;
  }
  if (!origin && found.length >= 2) origin = found[0];
  if (!destination && found.length >= 2) destination = found[found.length - 1];
  if (!destination && found.length === 1) destination = found[0];
  if (origin && destination && origin.id === destination.id && found.length >= 2) {
    destination = found.find((place) => place.id !== origin.id) || null;
  }
  return {
    transcript,
    origin,
    destination,
    deadlineText,
    preference: preference?.key || null,
    preferenceLabel: preference?.label || null,
    confidence: (origin ? 1 : 0) + (destination ? 1 : 0) + (deadlineText ? 0.5 : 0) + (preference ? 0.5 : 0),
  };
}

export function initVoiceAssistant({ places = [], onApply = null } = {}) {
  const root = document.getElementById('voiceAssistant');
  if (!root) return null;
  const transcriptEl = document.getElementById('vaTranscript');
  const chipsEl = document.getElementById('vaChips');
  const input = document.getElementById('vaText');
  const mic = document.getElementById('vaMic');
  let lastResult = null;
  let busy = false;

  const setTranscript = (html) => {
    if (transcriptEl) transcriptEl.innerHTML = html;
  };

  const render = (result) => {
    lastResult = result;
    if (!result) return;
    const chips = [];
    if (result.origin) chips.push(`<span class="va-chip"><em>起点</em><b>${escapeHtml(result.origin.name)}</b></span>`);
    if (result.destination) chips.push(`<span class="va-chip"><em>终点</em><b>${escapeHtml(result.destination.name)}</b></span>`);
    if (result.deadlineText) chips.push(`<span class="va-chip"><em>到达</em><b>${escapeHtml(result.deadlineText)}</b></span>`);
    if (result.preferenceLabel) chips.push(`<span class="va-chip"><em>偏好</em><b>${escapeHtml(result.preferenceLabel)}</b></span>`);
    const hasPlace = result.origin || result.destination;
    chipsEl.innerHTML = `${chips.join('')}${hasPlace ? '<button class="btn primary small" type="button" id="vaApply">应用到规划</button>' : ''}<button class="btn small quiet" type="button" id="vaClear">清空</button>`;
    const parts = [];
    if (result.origin && result.destination) parts.push(`从 <b>${escapeHtml(result.origin.name)}</b> 到 <b>${escapeHtml(result.destination.name)}</b>`);
    else if (result.destination) parts.push(`去 <b>${escapeHtml(result.destination.name)}</b>，起点沿用当前选择`);
    else if (result.origin) parts.push(`从 <b>${escapeHtml(result.origin.name)}</b> 出发，终点沿用当前选择`);
    if (result.deadlineText) parts.push(`<b>${escapeHtml(result.deadlineText)}</b> 前到达`);
    if (result.preferenceLabel) parts.push(`偏好<b>${escapeHtml(result.preferenceLabel)}</b>`);
    if (!parts.length) {
      setTranscript(`<div class="va-bubble assistant">我没有听清具体地点。可以说：“从双港到八一广场，下午六点前到，少走路”。</div>`);
    } else {
      setTranscript(`<div class="va-bubble user">${escapeHtml(result.transcript)}</div><div class="va-bubble assistant">好的，识别为：${parts.join('，')}。<br><span class="tiny faint">确认无误后点击“应用到规划”；不确定的地点会沿用当前选择。</span></div>`);
    }
    document.getElementById('vaApply')?.addEventListener('click', () => {
      onApply?.(lastResult);
      setTranscript(`<div class="va-bubble user">${escapeHtml(result.transcript)}</div><div class="va-bubble assistant">已应用，正在按新的起点、终点和时间重新规划。</div>`);
      toast('语音结果已应用到出行规划');
    });
    document.getElementById('vaClear')?.addEventListener('click', () => {
      lastResult = null;
      if (input) input.value = '';
      setTranscript('点击“说一句”，像聊天一样说出起点、终点、时间和偏好；我会提取关键地点并填入规划。');
      chipsEl.innerHTML = '';
    });
  };

  const parseAndRender = (text) => {
    const result = parseTravelUtterance(text, places);
    if (!result) {
      toast('请先说一句完整的话，例如“从华东交通大学到八一广场”。');
      return;
    }
    render(result);
  };

  document.querySelectorAll('[data-va-example]').forEach((button) => {
    button.addEventListener('click', () => {
      if (input) input.value = button.dataset.vaExample || button.textContent.replace(/[“”]/g, '');
      parseAndRender(button.dataset.vaExample || button.textContent);
    });
  });

  document.getElementById('vaSend')?.addEventListener('click', () => parseAndRender(input?.value || ''));
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      parseAndRender(input.value);
    }
  });

  mic?.addEventListener('click', () => {
    if (!SpeechRecognition) {
      toast('当前浏览器不支持语音识别，请在输入框直接输入一句话。');
      return;
    }
    if (busy) {
      busy = false;
      mic._recognition?.stop();
      mic.classList.remove('listening');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 3;
    mic._recognition = recognition;
    busy = true;
    mic.classList.add('listening');
    mic.setAttribute('aria-pressed', 'true');
    setTranscript('<div class="va-bubble assistant listening">正在听… 请像聊天一样说完整的一句。</div>');
    let finalText = '';
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += text;
        else interim += text;
      }
      if (interim) setTranscript(`<div class="va-bubble user">${escapeHtml(interim)}</div>`);
      if (finalText) {
        setTranscript(`<div class="va-bubble user">${escapeHtml(finalText)}</div>`);
        if (input) input.value = finalText;
        parseAndRender(finalText);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        toast('麦克风未授权。请在地址栏允许麦克风，或直接输入一句话。');
      } else if (event.error === 'no-speech') {
        toast('没有听到语音，请靠近麦克风再说一次。');
      } else if (event.error === 'network') {
        toast('浏览器语音服务当前不可用（可能离线），可直接输入一句话。');
      } else if (event.error !== 'aborted') {
        toast('语音识别未完成，请重试或直接输入。');
      }
    };
    recognition.onend = () => {
      busy = false;
      mic.classList.remove('listening');
      mic.setAttribute('aria-pressed', 'false');
    };
    try {
      recognition.start();
    } catch (error) {
      busy = false;
      mic.classList.remove('listening');
      toast('无法启动语音识别，请直接输入一句话。');
    }
  });

  return { parse: (text) => parseTravelUtterance(text, places), apply: (result) => onApply?.(result) };
}

/* ---------------- 每个方向的语音指令 ---------------- */

const COMMAND_HINTS = {
  traffic: '晚高峰，未来 30 分钟，看走廊',
  logistics: '起点南昌西站，生成方案',
  rail: '2 号线，南昌西站，安全',
  parking: '500 米，地下停车场',
};

export function initPageVoiceCommands(handlers = {}) {
  const buttons = document.querySelectorAll('[data-voice-command]');
  for (const button of buttons) {
    if (button.dataset.voiceCommandBound === '1') continue;
    button.dataset.voiceCommandBound = '1';
    const type = button.dataset.voiceCommand;
    button.addEventListener('click', () => {
      if (type === 'travel') {
        const panel = document.getElementById('voiceAssistant');
        panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => document.getElementById('vaMic')?.click(), 280);
        toast('已打开出行语音助手，请说完整句子。');
        return;
      }
      if (!SpeechRecognition) {
        toast(`当前浏览器不支持语音识别。可直接操作页面；示例：“${COMMAND_HINTS[type] || ''}”。`, 4200);
        return;
      }
      if (button.dataset.listening === '1') {
        button._recognition?.stop();
        return;
      }
      const recognition = new SpeechRecognition();
      recognition.lang = 'zh-CN';
      recognition.interimResults = false;
      recognition.continuous = false;
      recognition.maxAlternatives = 3;
      button._recognition = recognition;
      button.dataset.listening = '1';
      button.classList.add('listening');
      button.setAttribute('aria-pressed', 'true');
      toast(`正在听… 例如：“${COMMAND_HINTS[type] || ''}”`, 5000);
      recognition.onresult = (event) => {
        const text = event.results?.[0]?.[0]?.transcript?.trim() || '';
        if (!text) return;
        let message = '';
        try {
          message = handlers[type]?.(text, button) || '';
        } catch (error) {
          console.error(error);
          message = '执行时遇到问题，请重试或手动操作。';
        }
        toast(`听到“${text}” · ${message || '已执行'}`, 4600);
      };
      recognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          toast('麦克风未授权，请在地址栏允许麦克风，或手动操作。');
        } else if (event.error === 'no-speech') {
          toast('没有听到语音，请靠近麦克风再说一次。');
        } else if (event.error === 'network') {
          toast('浏览器语音服务当前不可用（可能离线），可手动操作。');
        } else if (event.error !== 'aborted') {
          toast('语音识别未完成，请重试或手动操作。');
        }
      };
      recognition.onend = () => {
        button.dataset.listening = '0';
        button.classList.remove('listening');
        button.setAttribute('aria-pressed', 'false');
      };
      try {
        recognition.start();
      } catch (error) {
        button.dataset.listening = '0';
        button.classList.remove('listening');
        toast('无法启动语音识别，请手动操作。');
      }
    });
  }
}
