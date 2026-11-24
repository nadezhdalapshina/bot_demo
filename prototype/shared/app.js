
(async function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };
  var esc = function (t) {
    return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  var COPY = window.MaxIcons.copy;

  var TRASH = window.MaxIcons.trash;

  var KIND = window.MaxStepUI;
  // Порядок выпадающего списка «Тип» в карточке узла.
  var KINDS = ['bot', 'user', 'contact', 'contact_modal', 'person_chat',
               'modal', 'toast', 'payment', 'external'];

  var bundle;
  try { bundle = await MaxAuthor.load(); } catch(e) { MaxAuthor.failure(e); return; }
  var DEFAULT = bundle.scenario;
  var EDIT = /[?&]edit(=1)?(&|$)/.test(window.MaxStandalone?.search??location.search);
  // Ключ версии: при правке предзаполненных контактов в файле его нужно
  // поднять, иначе редактор подхватит старый черновик из localStorage и
  // правки в файле не будут видны.
  var STORE_PATH = location.pathname.endsWith('/') ? location.pathname + 'index.html' : location.pathname;
  var STORE = 'max-draft:1:' + STORE_PATH.replace(/[^/]*$/, '') + ':' + bundle.id + ':' + bundle.revision;
  var S = clone(DEFAULT);
  var undoStack = [], redoStack = [], saveTimer = null;

  // Черновик подхватывается ТОЛЬКО в режиме редактора: прототип по обычной
  // ссылке всегда показывает то, что зашито в файл, иначе респондент увидел
  // бы чужие несохранённые правки.
  var fromDraft = false;
  if (EDIT && !window.MaxStandalone) {
    try {
      var raw = localStorage.getItem(STORE);
      if (raw) {
        var candidate=MaxAuthor.parse(raw);MaxAuthor.validate(candidate);
        await MaxMessageMedia.verify(candidate);
        var base=localStorage.getItem(STORE+':base');
        if(base && base!==JSON.stringify(DEFAULT)) {
          var keep=window.confirm('Данные сценария изменились после сохранения черновика. OK — открыть черновик; Отмена — открыть обновлённую версию. Черновик будет сохранён в резервной копии.');
          localStorage.setItem(STORE+':backup',raw);
          if(keep){S=candidate;fromDraft=true;}
        } else {S=candidate;fromDraft=true;}
      }
    } catch (e) { setTimeout(function(){ MaxAuthor.status('Черновик не загружен: ' + e.message, true); }, 0); }
  }

  function flushDraft() {
    clearTimeout(saveTimer); saveTimer = null;
    if(window.MaxStandalone)return;
    try { localStorage.setItem(STORE, JSON.stringify(S)); localStorage.setItem(STORE+':base', JSON.stringify(DEFAULT)); MaxAuthor.status('Черновик сохранён в браузере'); }
    catch(e) { MaxAuthor.status('Не удалось сохранить черновик. Скачайте JSON.', true); }
  }
  function save() {
    if (!EDIT) return;
    window.MaxStandalone?.changed();
    window.MaxAutosaveSession?.changed();
    MaxAuthor.status(window.MaxStandalone?'Есть изменения — нажмите «Скачать HTML».':'Есть изменения…');
    clearTimeout(saveTimer); saveTimer = setTimeout(flushDraft, 300);
  }
  function snapshot() {
    redoStack = [];
    undoStack.push(JSON.stringify(S));
    if (undoStack.length > 60) undoStack.shift();
    updateHistory();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(S));
    S = JSON.parse(undoStack.pop());
    buildGraph(); renderChrome(); syncPreview(); save();
    if (board) board.notice('Последнее изменение отменено.');
    updateHistory();
  }
  function updateHistory() {
    var u=$('#flUndo'),r=$('#flRedo'); if(u)u.disabled=!undoStack.length;if(r)r.disabled=!redoStack.length;
  }
  function redo() {
    if(!redoStack.length)return;
    undoStack.push(JSON.stringify(S));S=JSON.parse(redoStack.pop());
    buildGraph();renderChrome();syncPreview();save();updateHistory();
    if(board)board.notice('Изменение повторено.');
  }
  var trail = [];
  var timers = [];
  // Счётчик открытий внешних экранов в рамках текущего запуска прототипа.
  // Нужен для опционального сценария: первый клик открывает один URL,
  // повторные клики по той же внешней странице — другой URL.
  var externalOpenCount = {};
  var feed, overlay, layer, edgesSvg, viewport;
  var pan = { x: 40, y: 20 }, zoom = 1;
  var board = null, pendingPlacement = [];
  var toastTimer = null, payTimer = null, payNode = null;
  var payOpener = null;
  var imageViewer = null;

  /* ══════════════════════════════════════════════════════════════════════
     СПРАВОЧНИК КОНТАКТОВ И СОСТОЯНИЕ ВЫБОРА
     Один список на два узла: модалка «Выбор контакта» рисует из него список,
     «Чат с контактом» — шапку и ленту. Живёт в сценарии (S.contacts), поэтому
     правится в редакторе и попадает в скачанный файл.
     ══════════════════════════════════════════════════════════════════════ */
  var defaultBotAvatar = $('.tb-avatar img').getAttribute('src');
  function botAvatar() {
    return S.header.avatar?.src || defaultBotAvatar;
  }

  // Заголовок окна выбора контакта зафиксирован макетом и не настраивается.
  var PICK_TITLE = 'Переслать сообщение';
  var PERSON_MSG_DEFAULT = 'Привет! Это демонстрационное сообщение.';

  // Запасной аватар — градиент с инициалами (для новых контактов из редактора).
  var AVA_COLORS = [
    ['#416AFA', '#7B5CFA'], ['#12B76A', '#0E8F8F'], ['#F59E0B', '#EF6C4D'],
    ['#EC4899', '#8B5CF6'], ['#0EA5E9', '#416AFA'], ['#5568D9', '#8B5CF6'],
    ['#0E8F8F', '#12B76A'], ['#EF6C4D', '#F59E0B'], ['#8B5CF6', '#EC4899']
  ];
  function hashStr(s) {
    var h = 0;
    s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function initials(name) {
    return String(name || '').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  }
  function avatarOf(c) {
    if (!c) return '';
    if (c.avatar && MaxSafety.url(c.avatar,true)) return c.avatar;
    var col = AVA_COLORS[hashStr(c.id || c.name) % AVA_COLORS.length];
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + col[0] + '"/><stop offset="1" stop-color="' + col[1] + '"/>' +
      '</linearGradient></defs><rect width="80" height="80" fill="url(#g)"/>' +
      '<text x="40" y="41" text-anchor="middle" dominant-baseline="central" ' +
      'font-family="-apple-system,SF Pro Text,Roboto,system-ui,sans-serif" font-size="30" ' +
      'font-weight="500" fill="#ffffff">' + esc(initials(c.name)) + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  // Справочник чиним на лету: старый черновик в localStorage или откат
  // в редакторе могли оставить сценарий без contacts.
  function contacts() {
    if (!S.contacts || !S.contacts.length) S.contacts = clone(DEFAULT.contacts || []);
    return S.contacts || (S.contacts = []);
  }
  function contactById(id) {
    var list = contacts();
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    return null;
  }

  // Выбранный контакт живёт в памяти страницы: ни localStorage, ни
  // query-параметров, ни перезагрузки при переходе «модалка → чат».
  var selectedContactId = null;
  var personChat = null;   // {contactId, nodeId} — создан личный чат
  var botTrail = null;     // сохранённая лента бота
  var activeChat = 'bot';  // какой чат сейчас открыт: 'bot' или 'person'

  function personContact() {
    if (!personChat) return null;
    return contactById(personChat.contactId) || contacts()[0] || null;
  }

  /* ══════════════════════════════════════════════════════════════════════
     СПИСОК ЧАТОВ
     В макете строка одна — выбранный чат. В прототипе строк столько, сколько
     чатов реально открыто: чат с ботом (превью — последнее отправленное
     сообщение) и личный чат с контактом (превью — текст из узла «Чат с
     контактом»). Личный чат — это состояние превью, а не часть макета.
     ══════════════════════════════════════════════════════════════════════ */

  // Текст из узла показывается в списке чатов как превью: разметка **жирного**
  // и [ссылок](url) там лишняя, пустые строки схлопываем (в превью две строки).
  function previewText(t) {
    return String(t || '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();
  }

  function nodePreview(id) {
    var n = typeof id === 'object' ? id : S.nodes[id];
    if (!n) return '';
    if (n.type === 'contact') return n.name || '';          // карточка контакта
    if (n.type === 'person_chat') return previewText(n.message);
    return previewText(n.text);
  }

  // Последнее сообщение в переписке с ботом — то, что показываем в списке чатов.
  function botLastId() {
    var ids = botTrail || (activeChat === 'bot' ? trail : []);
    for (var i = ids.length - 1; i >= 0; i--) {
      if ((typeof ids[i] === 'object' || S.nodes[ids[i]]) && nodePreview(ids[i])) return ids[i];
    }
    return (S.intro || {}).auto || null;
  }

  // Строка открытого личного чата: аватар и галочки берём из разметки макета
  // (строка бота), остальное — из справочника контактов и узла «Чат с контактом».
  function personCellHTML() {
    var bot = $('#cellBot');
    var chk = bot && bot.querySelector('.cell-timegroup svg');
    var dot = bot && bot.querySelector('.cell-online');
    return '<button class="cell is-selected" type="button" id="cellPerson">' +
      '<span class="cell-avatar"><img class="avatar" src="" alt="">' +
        (dot ? dot.outerHTML : '') + '</span>' +
      '<span class="cell-mid">' +
        '<span class="cell-row1"><span class="cell-name"></span>' +
          '<span class="cell-timegroup">' + (chk ? chk.outerHTML : '') +
          '<span class="cell-time"></span></span></span>' +
        '<span class="cell-msg cell-msg-2"></span>' +
      '</span></button>';
  }

  function renderChatList(pc) {
    var botCell = $('#cellBot');
    if (botCell) {
      var lastId = botLastId();
      botCell.querySelector('.cell-name').textContent = S.header.name || '';
      botCell.querySelector('.cell-avatar img').setAttribute('src', botAvatar());
      var bm = botCell.querySelector('.cell-msg');
      if (bm) bm.textContent = nodePreview(lastId);
      botCell.classList.toggle('is-selected', activeChat === 'bot');
    }
    var list = $('.chat-list');
    if (!list) return;
    var pcell = $('#cellPerson');
    var existingPc = personContact();
    if (!existingPc) { if (pcell) list.removeChild(pcell); return; }
    if (!pcell) { pcell = el(personCellHTML()); list.insertBefore(pcell, list.firstElementChild); }
    pcell.classList.toggle('is-selected', activeChat === 'person');
    pcell.querySelector('.cell-name').textContent = existingPc.name || '';
    pcell.querySelector('.cell-time').textContent = (S.nodes[personChat.nodeId] || {}).time || '';
    pcell.querySelector('.cell-msg').textContent = nodePreview(personChat.nodeId);
    var img = pcell.querySelector('.cell-avatar img');
    if (img) img.setAttribute('src', avatarOf(existingPc));
    // Точка «в сети» — только у тех, кто действительно в сети.
    var dot = pcell.querySelector('.cell-online');
    if (dot) dot.style.display = (existingPc.status === 'В сети') ? '' : 'none';
  }

  /* ══════════════════════════════════════════════════════════════════════
     ПРОТОТИП
     ══════════════════════════════════════════════════════════════════════ */
  function renderChrome() {
    var h = S.header || {};
    document.title = h.name || 'Прототип чат-бота';
    var pc = activeChat === 'person' ? personContact() : null;
    var topbar = $('.chat-topbar');
    if (topbar) topbar.classList.toggle('is-person', !!pc);
    var ava = $('.tb-avatar img');
    if (pc) {
      // Имя, статус и аватар собеседника берутся из справочника — в узле
      // «Чат с контактом» они не заполняются руками.
      $('.tb-name').textContent = pc.name || '';
      $('.st-mobile').textContent = pc.status || '';
      $('.st-desktop').textContent = pc.status || '';
      if (ava) ava.setAttribute('src', avatarOf(pc));
    } else {
      $('.tb-name').textContent = h.name || '';
      $('.st-mobile').textContent = h.statusMobile || '';
      $('.st-desktop').textContent = h.statusDesktop || '';
      if (ava) ava.setAttribute('src', botAvatar());
    }
    renderChatList(pc);
  }

  function el(html) {
    var d = document.createElement('div'); d.innerHTML = html.trim();
    d.querySelectorAll('img').forEach(function(img){img.referrerPolicy='no-referrer';});
    return d.firstElementChild;
  }
  function tpl(id) { return document.getElementById(id).content.cloneNode(true); }

  function capsule(t) {
    return el('<div class="capsule-row"><span class="capsule">' + esc(t) + '</span></div>');
  }

  function botCard(card) {
    var n = tpl('tpl-botcard');
    n.querySelector('.botcard-avatar img').setAttribute('src', botAvatar());
    n.querySelector('[data-bind="cardName"]').textContent = card.name || '';
    n.querySelector('[data-bind="cardCaption"]').textContent = card.caption || '';
    return n;
  }

  function bubbleText(t) {
    // Экранируем всё, затем возвращаем **жирный** и [ссылку](url) —
    // в макетах в тексте бота встречается и то и другое.
    var html = esc(t)
      .replace(/\n/g, '<br>')
      .replace(/\[([^\]]+)\]\(([^)\s]*)\)/g,
               '<a href="$2" onclick="return false" style="color:var(--text-themed)">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    // Visible plain URLs get the same local boundary as markdown links.
    // The text and the scenario destination data stay unchanged.
    var template = document.createElement('template');
    template.innerHTML = html;
    var walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT), texts = [], text;
    while ((text = walker.nextNode())) if (!text.parentElement || !text.parentElement.closest('a')) texts.push(text);
    texts.forEach(function (node) {
      var matches = Array.from(node.textContent.matchAll(/https?:\/\/[^\s]+/g));
      if (!matches.length) return;
      var fragment = document.createDocumentFragment(), offset = 0;
      matches.forEach(function (match) {
        var url = match[0].replace(/[.,;!?]+$/, '');
        fragment.append(document.createTextNode(node.textContent.slice(offset, match.index)));
        var link = document.createElement('a');link.href = url;link.textContent = url;
        link.style.color = 'var(--text-themed)';link.setAttribute('onclick', 'return false');fragment.append(link);
        offset = match.index + url.length;
      });
      fragment.append(document.createTextNode(node.textContent.slice(offset)));node.replaceWith(fragment);
    });
    template.content.querySelectorAll('a').forEach(function(link){
      if(!MaxSafety.url(link.getAttribute('href'))){link.replaceWith(document.createTextNode(link.textContent));return;}
      link.setAttribute('href','#');link.setAttribute('rel','noopener noreferrer');
    });
    return template.innerHTML;
  }

  function botMessage(node, id, live) {
    var btns = (node.buttons || []).filter(function (b) { return b && b.label; });
    var locked = S.lockPreviousButtons && !live && btns.length > 0;
    var image = MaxMessageMedia.picture(node, id);
    var h = '<div class="msg-row in"><div class="bubble-stack' + (btns.length ? ' has-actions' : '') + '">' +
      '<div class="bubble in' + (image ? ' has-message-image' + (node.text ? '' : ' is-image-only') : '') + '">' + image + (image ? '<div class="message-caption">' : '') + '<p class="msg-text">' + bubbleText(node.text) + '</p>' +
      '<span class="msg-time">' + esc(node.time || '') + '</span>' + (image ? '</div>' : '') + '</div>';
    if (btns.length) {
      h += '<div class="bot-actions">';
      btns.forEach(function (b, i) {
        h += '<button class="bot-btn' + (locked ? ' is-locked' : '') + '" type="button"' +
          (locked ? ' disabled' : '') + ' data-node="' + esc(id) + '" data-index="' + i + '">' +
          esc(b.label) + '</button>';
      });
      h += '</div>';
    }
    return el(h + '</div></div>');
  }

  function userMessage(node, id) {
    var image = MaxMessageMedia.picture(node, id);
    return el('<div class="msg-row out"><div class="bubble out' + (image ? ' has-message-image' + (node.text ? '' : ' is-image-only') : '') + '">' + image + (image ? '<div class="message-caption">' : '') +
      '<p class="msg-text">' + (node.typed ? esc(node.text) : bubbleText(node.text)) + '</p>' +
      '<span class="msg-time">' + esc(node.time || '') + '</span>' + (image ? '</div>' : '') + '</div></div>');
  }

  function contactMessage(node) {
    var n = tpl('tpl-contact');
    var ini = String(node.name || '').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
    n.querySelector('[data-bind="contactInitials"]').textContent = ini;
    n.querySelector('[data-bind="contactName"]').textContent = node.name || '';
    n.querySelector('[data-bind="contactSub"]').textContent = node.sub || '';
    n.querySelector('[data-bind="contactTime"]').textContent = node.time || '';
    return n;
  }

  // Пересланное сообщение в личном чате: тот же пузырь, что у исходящих
  // сообщений бота, но с белым фоном из макета и временем с галочками.
  function personMessage(node, id) {
    var image = MaxMessageMedia.picture(node, id);
    return el('<div class="msg-row out"><div class="bubble out bubble--person' + (image ? ' has-message-image' + (node.message ? '' : ' is-image-only') : '') + '">' + image + (image ? '<div class="message-caption">' : '') +
      '<p class="msg-text">' + bubbleText(node.message) + '</p>' +
      '<span class="msg-time">' + esc(node.time || '') +
      '<svg class="ico" aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10.9803 4.68023C11.2732 4.38734 11.2732 3.91247 10.9803 3.61957C10.6874 3.32668 10.2126 3.32668 9.91967 3.61957L3.1 10.4392L1.53033 8.86957C1.23744 8.57668 0.762563 8.57668 0.46967 8.86957C0.176777 9.16247 0.176777 9.63734 0.46967 9.93023L2.56967 12.0302C2.86256 12.3231 3.33744 12.3231 3.63033 12.0302L10.9803 4.68023Z" fill="currentColor"/><path d="M15.5296 4.68023C15.8225 4.38734 15.8225 3.91247 15.5296 3.61957C15.2368 3.32668 14.7619 3.32668 14.469 3.61957L7.64932 10.4392L7.6358 10.4257C7.34291 10.1328 6.86803 10.1328 6.57514 10.4257C6.28225 10.7186 6.28225 11.1935 6.57514 11.4864L7.11899 12.0302C7.41188 12.3231 7.88675 12.3231 8.17965 12.0302L15.5296 4.68023Z" fill="currentColor"/></svg>' +
      '</span>' + (image ? '</div>' : '') + '</div></div>');
  }

  function renderFeed() {
    var frag = document.createDocumentFragment();
    var intro = S.intro || {};
    if (intro.date) frag.appendChild(capsule(intro.date));
    // В личном чате карточку бота не показываем — в макете там только
    // капсула с датой и пересланное сообщение.
    if (intro.card && activeChat !== 'person') frag.appendChild(botCard(intro.card));

    trail.forEach(function (id, i) {
      var n = typeof id === 'object' ? id : S.nodes[id];
      if (!n) return;
      // «живое» сообщение — последнее сообщение бота в ленте
      var live = true;
      for (var j = i + 1; j < trail.length; j++) {
        var nx = S.nodes[trail[j]];
        if (nx && nx.type === 'bot') { live = false; break; }
      }
      if (n.type === 'contact') frag.appendChild(contactMessage(n));
      else if (n.type === 'user') frag.appendChild(userMessage(n, id));
      else if (n.type === 'person_chat') frag.appendChild(personMessage(n, id));
      else frag.appendChild(botMessage(n, id, live));
    });

    feed.innerHTML = '';
    feed.appendChild(frag);
    feed.scrollTop = feed.scrollHeight;
    // Лента изменилась — в списке чатов обновляем превью последнего сообщения.
    renderChatList(personContact());
  }

  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  function milliseconds(value,fallback){var n=Number(value);return value==null||value===''||!Number.isFinite(n)||n<0?fallback:n;}
  function go(id, depth, chain) {
    chain=chain||[];if(chain.includes(id)){MaxAuthor.status('Цикл автоматических переходов остановлен.',true);return;}chain=chain.concat(id);
    var n = S.nodes[id];
    if (!n) return;
    if (n.type === 'contact_modal') { openPick(id); return; }
    if (n.type === 'person_chat') { enterPersonChat(id, depth, chain); return; }
    if (n.type === 'modal') { openModal(id); return; }
    if (n.type === 'payment') { openPay(id); return; }
    if (n.type === 'external') {
      // Внешние продуктовые экраны живут отдельными HTML-страницами.
      // Всегда открываем их в новой вкладке, чтобы состояние бота сохранилось.
      // Если у узла заполнен repeatUrl, первое открытие ведёт на url,
      // второе и последующие — на repeatUrl. Для узлов без repeatUrl
      // поведение остаётся прежним.
      var opened = externalOpenCount[id] || 0;
      var externalUrl = (opened > 0 && n.repeatUrl) ? n.repeatUrl : n.url;
      externalOpenCount[id] = opened + 1;
      if (MaxSafety.url(externalUrl)) window.open(externalUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    if (n.type === 'toast') {
      // тост — не сообщение: в ленту не попадает, живёт поверх интерфейса
      showToast(n);
      if (n.auto && S.nodes[n.auto] && (depth || 0) < 1000) {
        timers.push(setTimeout(function () { go(n.auto, (depth || 0) + 1, chain); }, 450));
      }
      return;
    }
    // Если пользователь сейчас в личном чате, фоновые сообщения бота
    // продолжают приходить в сохранённую переписку бота, не подменяя текущий чат.
    if (activeChat === 'person' && personChat) {
      if (!botTrail) botTrail = [];
      botTrail.push(id);
      renderChatList(personContact());
    } else {
      trail.push(id);
      if (personChat) botTrail = trail.slice();
      renderFeed();
    }
    // «само по себе»: узел ведёт дальше без участия пользователя
    if (n.auto && S.nodes[n.auto] && (depth || 0) < 1000) {
      var delay = milliseconds(n.autoDelay,milliseconds(S.autoDelay,700));
      timers.push(setTimeout(function () { go(n.auto, (depth || 0) + 1, chain); }, delay));
    }
  }

  // Личный чат — это состояние текущего экрана, а не отдельная страница:
  // тот же интерфейс MAX, но с собеседником из справочника и уже отправленным
  // сообщением. Дальше по графу можно идти как из любого другого узла.
  function enterPersonChat(id, depth, chain) {
    var n = S.nodes[id]; if (!n) return;
    if (!botTrail) botTrail = trail.slice();
    personChat = {
      contactId: selectedContactId || ((contacts()[0] || {}).id || ''),
      nodeId: id
    };
    activeChat = 'person';
    trail = [id];
    renderChrome();
    renderFeed();
    if (n.auto && S.nodes[n.auto] && (depth || 0) < 1000) {
      var delay = milliseconds(n.autoDelay,milliseconds(S.autoDelay,700));
      timers.push(setTimeout(function () { go(n.auto, (depth || 0) + 1, chain); }, delay));
    }
  }

  // Переключение чатов не является переходом по графу.
  // Возврат к боту восстанавливает его переписку ровно в том состоянии,
  // в котором она была оставлена (включая сообщения, пришедшие по таймеру).
  function switchToBotChat() {
    if (!personChat) return;
    activeChat = 'bot';
    trail = (botTrail || []).filter(function (x) { return typeof x === 'object' || S.nodes[x]; });
    renderChrome();
    renderFeed();
  }

  function switchToPersonChat() {
    if (!personChat || !S.nodes[personChat.nodeId]) return;
    if (activeChat === 'bot') botTrail = trail.slice();
    activeChat = 'person';
    trail = [personChat.nodeId].concat(personChat.messages || []);
    renderChrome();
    renderFeed();
  }

  function restart() {
    if (imageViewer) imageViewer.close();
    clearTimers();
    if (overlay) overlay.classList.remove('is-open');
    modalId = null; lastFocused = null;
    hideToast();
    closePay(false);
    closePick();
    trail = [];
    externalOpenCount = {};
    selectedContactId = null;
    personChat = null;
    botTrail = null;
    activeChat = 'bot';
    renderChrome();
    renderFeed();
    var first = (S.intro || {}).auto;
    if (first && S.nodes[first]) timers.push(setTimeout(function () { go(first, 0); }, 250));
  }

  function syncPreview() {
    trail = trail.filter(function (id) { return typeof id === 'object' || S.nodes[id]; });
    // Узел личного чата могли удалить или переименовать — тогда выходим из
    // режима чата, иначе «Назад» вернёт в никуда.
    if (personChat && !S.nodes[personChat.nodeId]) {
      personChat = null; botTrail = null; activeChat = 'bot';
    }
    renderChrome();
    if (payNode && S.nodes[payNode]?.type==='payment') renderPayment(S.nodes[payNode]);
    if (!trail.length) restart(); else renderFeed();
  }

  function feedClick(e) {
    var b = e.target.closest('.bot-btn');
    if (!b || b.disabled) return;
    var n = S.nodes[b.getAttribute('data-node')];
    if (!n) return;
    var list = (n.buttons || []).filter(function (x) { return x && x.label; });
    var act = list[+b.getAttribute('data-index')];
    if(act&&act.label==='Перезапустить бота'){restart();return;}
    if (act && act.target) go(act.target, 0);
  }

  /* ── тост ─────────────────────────────────────────────────────────── */
  function showToast(n) {
    var t = $('#toast');
    $('#toastTitle').textContent = n.title || '';
    $('#toastSub').textContent = n.sub || '';
    t.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-open'); },
                            milliseconds(n.duration,2500));
  }
  function hideToast() {
    clearTimeout(toastTimer);
    var t = $('#toast'); if (t) t.classList.remove('is-open');
  }

  /* ── окно оплаты ──────────────────────────────────────────────────── */
  var paymentCopy = [
    ['title', 'payTitle', 'Заголовок чекаута', 'Демонстрационная оплата'],
    ['noteTpl', 'payNote', 'Описание под ценой', 'Тестовый заказ'],
    ['payLabel', 'payButtonLabel', 'Текст кнопки', 'Подключить за {price}'],
    ['payConsent', 'payConsent', 'Подпись под кнопкой', 'Деньги не списываются'],
    ['payLegal', 'payLegal', 'Текст внизу окна', 'Это демонстрация оформления. Оплата не проводится.'],
    ['successTitle', 'paySuccessTitle', 'Заголовок после оплаты', 'Оплачено'],
    ['successText', 'paySuccessNote', 'Описание после оплаты', 'Демонстрационный платёж завершён'],
  ];

  function fill(text, n) {
    return text.replace(/\{(price|members)\}/g, (_, key) => n[key] || '');
  }

  function renderPayment(n) {
    $('#payPrice').textContent = n.price || '';
    $('#payDoneNote').textContent = fill(n.doneTpl ?? 'Тестовый заказ оформлен', n);
    for (const [field, id, , fallback] of paymentCopy) {
      $('#'+id).textContent = fill(n[field] ?? fallback, n);
    }
  }

  function openPay(id) {
    payOpener = document.activeElement;
    var n = S.nodes[id]; if (!n) return;
    payNode = id;
    clearTimeout(payTimer);
    renderPayment(n);
    $('#payCard').classList.remove('is-paid');
    setMethod('card');
    $('#payOverlay').classList.add('is-open');
    $('#payOverlay').setAttribute('aria-modal',EDIT?'false':'true');
    focusDialog($('#payOverlay'),$('#payPay'));
  }
  function setMethod(m) {
    $$('.pay-cell').forEach(function (c) {
      c.classList.toggle('is-on', c.getAttribute('data-method') === m);
    });
  }
  function focusDialog(root,control){
    const previous=document.activeElement,deadline=performance.now()+350;
    function focus(){
      if(!root.classList.contains('is-open')||root.inert)return;
      if(document.activeElement!==previous&&document.activeElement!==document.body)return;
      control.focus({preventScroll:true});
      // A visibility transition can still make the control unfocusable on the
      // opening frame. Retry while the opener owns focus; never steal it back.
      if(document.activeElement!==control&&performance.now()<deadline)requestAnimationFrame(focus);
    }
    focus();
  }
  // Закрыть можно и до оплаты, и после. Если оплата прошла — закрытие
  // ведёт туда же, куда и таймер: к следующему сообщению бота.
  function closePay(advance) {
    var wasOpen = $('#payOverlay').classList.contains('is-open');
    clearTimeout(payTimer);
    var paid = $('#payCard').classList.contains('is-paid');
    var next = (S.nodes[payNode] || {}).auto;
    $('#payOverlay').classList.remove('is-open');
    $('#payCard').classList.remove('is-paid');
    payNode = null;
    if(wasOpen&&payOpener?.isConnected)payOpener.focus();payOpener=null;
    if (advance !== false && paid && next) go(next, 0);
  }
  // Оплата → успешное состояние → через successDelay окно само закрывается
  // и бот присылает следующий шаг (пункт 7 постановки).
  function payNow() {
    if($('#payCard').classList.contains('is-paid'))return;
    var n = S.nodes[payNode]; if (!n) return;
    $('#payCard').classList.add('is-paid');
    var wait = milliseconds(n.successDelay,6000);
    payTimer = setTimeout(function () { closePay(); }, wait);
  }

  /* ── модалка ──────────────────────────────────────────────────────── */
  var modalId = null, lastFocused = null;

  function openModal(id) {
    var m = S.nodes[id]; if (!m) return;
    modalId = id;
    $('#mTitle').textContent = m.title || '';
    $('#mDesc').textContent = m.text || '';
    $('#mConfirm').textContent = m.confirmLabel || '';
    $('#mCancel').textContent = m.cancelLabel || '';
    lastFocused = document.activeElement;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-modal',EDIT?'false':'true');
    focusDialog(overlay,$('#mConfirm'));
  }

  function closeModal(which) {
    var m = S.nodes[modalId] || {};
    overlay.classList.remove('is-open');
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    var t = which === 'ok' ? m.confirmTarget : which === 'no' ? m.cancelTarget : '';
    modalId = null;
    if (t) go(t, 0);
  }

  /* ── модальное окно «Выбор контакта» ──────────────────────────────── */
  var pickId = null, pickTab = 'all', pickQuery = '';

  function pickItems() {
    var q = pickQuery.trim().toLowerCase();
    return contacts().filter(function (c) {
      if (pickTab === 'new' && !c.unread) return false;
      if (pickTab === 'channels' && !c.channel) return false;
      if (q && String(c.name || '').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function renderPick() {
    var list = pickItems();
    var box = $('#pickList');
    if (box) {
      box.innerHTML = list.length ? list.map(function (c) {
        return '<button class="pick-row' +
          (c.id === selectedContactId ? ' is-selected' : '') +
          (c.unread ? ' is-unread' : '') +
          '" type="button" data-pick="' + esc(c.id) + '">' +
          '<span class="pick-ava"><img src="' + esc(avatarOf(c)) + '" alt=""></span>' +
          '<span class="pick-mid">' +
            '<span class="pick-name">' + esc(c.name || '') + '</span>' +
            '<span class="pick-sub">' + esc(c.status || '') + '</span>' +
          '</span></button>';
      }).join('') : '<div class="pick-empty">Ничего не найдено</div>';
    }
    var cnt = contacts().filter(function (c) { return c.unread; }).length;
    var badge = $('#pickCount');
    if (badge) { badge.textContent = cnt; badge.hidden = !cnt; }
    $$('.pick-tab').forEach(function (t) {
      t.classList.toggle('is-on', t.getAttribute('data-tab') === pickTab);
    });
  }

  function openPick(id) {
    pickId = id; pickTab = 'all'; pickQuery = '';
    var inp = $('#pickInput');
    if (inp) inp.value = '';
    renderPick();
    lastFocused = document.activeElement;
    $('#pickOverlay').classList.add('is-open');
    $('#pickOverlay').setAttribute('aria-modal',EDIT?'false':'true');
    if (inp) focusDialog($('#pickOverlay'),inp);
  }

  // Крестик, клик по затемнению и Escape закрывают окно БЕЗ перехода —
  // сценарий остаётся на том же шаге.
  function closePick() {
    var ov = $('#pickOverlay');
    if (!ov) { pickId = null; return; }
    var wasOpen = ov.classList.contains('is-open');
    ov.classList.remove('is-open');
    pickId = null;
    if (wasOpen && lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
  }

  // Выбор контакта запоминается в состоянии страницы и ведёт в единственный
  // общий target узла — отдельного перехода на каждого контакта нет.
  function pickContact(cid) {
    var n = S.nodes[pickId] || {};
    selectedContactId = cid;
    var t = n.target || '';
    closePick();
    if (t) go(t, 0);
  }

  /* ══════════════════════════════════════════════════════════════════════
     СХЕМА
     ══════════════════════════════════════════════════════════════════════ */
  function allNodes() {
    var out = [{ id: '__meta', kind: 'meta' }, { id: '__intro', kind: 'intro' }];
    Object.keys(S.nodes).forEach(function (id) { out.push({ id: id, kind: S.nodes[id].type || 'bot' }); });
    return out;
  }
  function pos(id) {
    var o = id === '__intro' ? S.intro : id === '__meta' ? (S.meta = S.meta || {}) : S.nodes[id];
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) { o.x = 40; o.y = 40; pendingPlacement.push(id); }
    return o;
  }

  function card(id, kind) {
    var p = pos(id);
    var h = '<div class="fl-node" data-id="' + esc(id) + '" data-kind="' + kind + '" ' +
      'style="left:' + p.x + 'px;top:' + p.y + 'px' + (KIND[kind] ? ';--ink:' + KIND[kind].color : '') + '">';

    h += '<div class="fl-head">' + (KIND[kind] ? '<span class="editor-icon fl-type-icon" aria-hidden="true">' + MaxIcons[KIND[kind].icon] + '</span>' : '<span class="fl-dot"></span>') + '<span class="fl-kind">' +
      (kind === 'meta' ? 'Шапка чата' : kind === 'intro' ? 'Начало переписки' : KIND[kind].label) +
      '</span>' +
      // Технический id узла в интерфейсе не показываем — он нужен только
      // внутри сценария, а в карточке читается как мусор.
      (kind === 'meta' || kind === 'intro' ? '' :
        '<span class="fl-grow"></span>' +
        '<button class="fl-x" data-dup="' + esc(id) + '" title="Дублировать">' + COPY + '</button>' +
        '<button class="fl-x fl-x--node" data-del="' + esc(id) + '" title="Удалить узел">' + TRASH + '</button>') +
      '</div><div class="fl-body">';

    if (kind !== 'meta' && kind !== 'intro') {
      h += '<div><div class="fl-lab">Тип</div><select class="fl-sel" data-type="' + esc(id) + '">' +
        KINDS.map(function (k) {
          return '<option value="' + k + '"' + (k === kind ? ' selected' : '') + '>' + KIND[k].label + '</option>';
        }).join('') + '</select></div>';
    }

    if (kind === 'meta') {
      h += fld('Имя бота', 'header.name', S.header.name) +
        fld('Подпись на мобильной', 'header.statusMobile', S.header.statusMobile) +
        fld('Подпись на десктопе', 'header.statusDesktop', S.header.statusDesktop) +
        MaxMessageMedia.field('__meta', S.header.avatar, 'аватар');
    } else if (kind === 'intro') {
      h += fld('Дата (капсула)', 'intro.date', S.intro.date) +
        fld('Имя в карточке', 'intro.card.name', S.intro.card.name) +
        area('Описание в карточке', 'intro.card.caption', S.intro.card.caption);
    } else if (kind === 'modal') {
      var m = S.nodes[id];
      h += fld('Заголовок', 'nodes.' + id + '.title', m.title) +
        area('Описание', 'nodes.' + id + '.text', m.text) +
        '<div class="fl-lab">Действия</div>' +
        '<div class="fl-row"><input class="fl-in" data-path="nodes.' + esc(id) + '.confirmLabel" value="' + esc(m.confirmLabel || '') + '">' +
        '<span class="fl-port fl-port--out' + (m.confirmTarget ? ' is-linked' : '') + '" data-port="ok:' + esc(id) + '"></span></div>' +
        '<div class="fl-row"><input class="fl-in" data-path="nodes.' + esc(id) + '.cancelLabel" value="' + esc(m.cancelLabel || '') + '">' +
        '<span class="fl-port fl-port--out' + (m.cancelTarget ? ' is-linked' : '') + '" data-port="no:' + esc(id) + '"></span></div>';
    } else if (kind === 'contact_modal') {
      h += '<div class="fl-lab">Заголовок</div>' +
        '<div class="fl-ro">' + esc(PICK_TITLE) + '</div>' +
        '<div class="fl-lab">Контакты — имя, статус, аватар</div>';
      contacts().forEach(function (c, i) {
        h += '<div class="fl-row">' +
          '<span class="fl-ava"><img src="' + esc(avatarOf(c)) + '" alt=""></span>' +
          '<div class="fl-col">' +
            '<input class="fl-in" data-path="contacts.' + i + '.name" value="' + esc(c.name || '') + '" placeholder="Имя">' +
            '<input class="fl-in" data-path="contacts.' + i + '.status" value="' + esc(c.status || '') + '" placeholder="Статус">' +
            '<input class="fl-in" data-path="contacts.' + i + '.avatar" value="' + esc(c.avatar || '') + '" placeholder="Аватар: URL или data:URI (пусто — инициалы)">' +
          '</div>' +
          '<button class="fl-x" data-delcontact="' + i + '" title="Убрать контакт">' + TRASH + '</button>' +
          '</div>';
      });
      h += '<button class="fl-add" data-addcontact="1">' + MaxIcons.plus + 'Добавить</button>';
    } else if (kind === 'person_chat') {
      h += '<div class="fl-note">' +
        'Имя, статус и аватар подставляются автоматически из справочника — ' +
        'в самом узле они не заполняются.</div>' +
        MaxMessageMedia.field(id, S.nodes[id].image) +
        area('Текст отправленного сообщения', 'nodes.' + esc(id) + '.message', S.nodes[id].message, true) +
        fld('Время', 'nodes.' + esc(id) + '.time', S.nodes[id].time);
    } else if (kind === 'payment') {
      var pn = S.nodes[id];
      h += fld('Цена', 'nodes.' + id + '.price', pn.price) +
        fld('Участников', 'nodes.' + id + '.members', pn.members) +
        paymentCopy.map(([field, , label, fallback]) =>
          area(label, 'nodes.' + id + '.' + field, pn[field] ?? fallback)).join('') +
        '<div class="fl-note">В тексте можно использовать {price} для цены и {members} для числа участников.</div>';
    } else if (kind === 'external') {
      var en = S.nodes[id];
      h += fld('URL при первом открытии', 'nodes.' + id + '.url', en.url) +
        fld('URL при повторном открытии (опционально)', 'nodes.' + id + '.repeatUrl', en.repeatUrl || '') +
        '<div class="fl-note">Откроется в новой вкладке. Если второй URL оставить пустым, при каждом нажатии будет открываться первый экран. Если заполнить — первый клик откроет первый URL, второй и последующие клики по этой же кнопке/внешней странице откроют второй. Для страницы рядом с index.html укажи, например, <b>example.html</b>.</div>';
    } else if (kind === 'toast') {
      var tn = S.nodes[id];
      h += fld('Заголовок', 'nodes.' + id + '.title', tn.title) +
        fld('Описание (можно пусто)', 'nodes.' + id + '.sub', tn.sub) +
        fld('Сколько висит, мс', 'nodes.' + id + '.duration', tn.duration);
    } else if (kind === 'contact') {
      var c = S.nodes[id];
      h += fld('Имя контакта', 'nodes.' + id + '.name', c.name) +
        fld('Подпись', 'nodes.' + id + '.sub', c.sub) +
        fld('Время', 'nodes.' + id + '.time', c.time);
    } else {
      var n = S.nodes[id];
      if (kind === 'bot' || kind === 'user') h += MaxMessageMedia.field(id, n.image);
      h += area(kind === 'user' ? 'Что пишет юзер' : 'Текст сообщения', 'nodes.' + id + '.text', n.text, true);
      if (kind === 'bot') {
        h += '<div class="fl-lab">Действия</div>';
        (n.buttons || []).forEach(function (b, i) {
          h += '<div class="fl-row"><input class="fl-in" data-path="nodes.' + esc(id) + '.buttons.' + i + '.label" ' +
            'value="' + esc(b.label || '') + '" placeholder="Подпись">' +
            '<button class="fl-x" data-delbtn="' + esc(id) + '|' + i + '" title="Убрать кнопку">' + TRASH + '</button>' +
            '<span class="fl-port fl-port--out' + (b.target ? ' is-linked' : '') + '" data-port="btn:' + esc(id) + ':' + i + '"></span></div>';
        });
        h += '<button class="fl-add" data-addbtn="' + esc(id) + '">' + MaxIcons.plus + 'Добавить</button>';
      }
      h += fld('Время', 'nodes.' + id + '.time', n.time);
    }
    h += '</div>';

    if (kind === 'contact_modal') {
      // У окна выбора контакта ровно один выход — на ветку личного чата.
      var cmn = S.nodes[id];
      h += '<div class="fl-foot"><span>дальше — чат с контактом</span>' +
        '<span class="fl-grow"></span><span class="fl-port fl-port--out' +
        (cmn.target ? ' is-linked' : '') + '" data-port="target:' + esc(id) + '"></span></div>';
    } else if (kind !== 'meta' && kind !== 'modal' && kind !== 'external') {
      var o = kind === 'intro' ? S.intro : S.nodes[id];
      // Для обычных auto-переходов задержку можно настраивать прямо в редакторе.
      // В сценарии хранится в миллисекундах, в интерфейсе показываем секунды.
      if (kind !== 'intro' && kind !== 'toast' && kind !== 'payment') {
        var delaySec = (o.autoDelay != null && o.autoDelay !== '')
          ? (+o.autoDelay / 1000)
          : ((+S.autoDelay || 800) / 1000);
        h += '<div class="fl-delay"><div class="fl-lab">Задержка автоперехода, сек</div>' +
          '<input class="fl-in" type="number" min="0" step="0.5" data-delay-node="' + esc(id) +
          '" value="' + esc(delaySec) + '">' +
          '<div class="fl-note">Сработает после появления этой ноды, если подключен выход «дальше само собой».</div></div>';
      }
      h += '<div class="fl-foot"><span>' + (kind === 'intro' ? 'начать с' : 'дальше само собой') + '</span>' +
        '<span class="fl-grow"></span><span class="fl-port fl-port--out' + (o.auto ? ' is-linked' : '') +
        '" data-port="auto:' + esc(id) + '"></span></div>';
    }
    if (kind === 'toast') h += '<div class="fl-note">Автопереход: 0,45 сек. Длительность показа задаётся выше.</div>';
    if (kind === 'payment') h += '<div class="fl-note">После оплаты: ' + esc((+S.nodes[id].successDelay || 6000)/1000) + ' сек.</div>';
    return h + '</div>';
  }

  function fld(label, path, v) {
    return '<div><div class="fl-lab">' + esc(label) + '</div>' +
      '<input class="fl-in" data-path="' + path + '" value="' + esc(v || '') + '"></div>';
  }
  function area(label, path, v, big) {
    return '<div><div class="fl-lab">' + esc(label) + '</div>' +
      '<textarea class="fl-ta' + (big ? ' fl-ta--msg' : '') + '" data-path="' + path + '">' +
      esc(v || '') + '</textarea></div>';
  }

  function buildGraph() {
    layer.innerHTML = '<svg class="fl-edges" id="flEdges"></svg>' +
      allNodes().map(function (n) { return card(n.id, n.kind); }).join('');
    edgesSvg = $('#flEdges');
    var startId = (S.intro || {}).auto;
    var sn = layer.querySelector('.fl-node[data-id="' + startId + '"]');
    if (sn) sn.classList.add('is-start');
    MaxEditorUI.organizeCards(layer);
    layer.querySelectorAll('.fl-node:not([data-kind="intro"]):not([data-kind="meta"])').forEach(function(n){['left','right','top','bottom'].forEach(function(side){var slot=document.createElement('span');slot.className='fl-input-slot';slot.dataset.side=side;slot.setAttribute('aria-hidden','true');n.append(slot);});});
    drawEdges();
    if (board) { board.refresh(); if(pendingPlacement.length) board.repair(false, pendingPlacement.splice(0), true); }
  }

  function portEl(key) { return layer.querySelector('.fl-port[data-port="' + key + '"]'); }

  function localPos(node) {
    var lr = layer.getBoundingClientRect(), r = node.getBoundingClientRect();
    return { x: (r.left + r.width / 2 - lr.left) / zoom, y: (r.top + r.height / 2 - lr.top) / zoom };
  }

  // Four centered inputs; a dragged connection keeps its chosen side.
  function inPos(id, from, key) {
    var n = layer.querySelector('.fl-node[data-id="' + id + '"]');
    if (!n) return null;
    var saved=key && (S._boardInputSides || {})[key];
    var points=Array.from(n.querySelectorAll('.fl-input-slot')).map(function(slot){return Object.assign(localPos(slot),{side:slot.dataset.side});});
    if(saved && saved.target===id){var fixed=points.find(function(p){return p.side===saved.side;});if(fixed)return fixed;}
    return points.sort(function(a,b){return Math.hypot(a.x-from.x,a.y-from.y)-Math.hypot(b.x-from.x,b.y-from.y);})[0];
  }

  function curve(a, b) {
    var d = Math.min(80, Math.max(18, Math.abs(b.x - a.x) * 0.35));
    var c1 = { x: a.x + d, y: a.y };                    // выход из порта — всегда вправо
    var c2 = { x: b.x, y: b.y };
    if (b.side === 'left') c2.x -= d;
    else if (b.side === 'right') c2.x += d;
    else if (b.side === 'top') c2.y -= d;
    else c2.y += d;
    return 'M' + a.x + ',' + a.y + ' C' + c1.x + ',' + c1.y + ' ' + c2.x + ',' + c2.y + ' ' + b.x + ',' + b.y;
  }

  function edgeList() {
    var out = [];
    if ((S.intro || {}).auto) out.push(['auto:__intro', S.intro.auto]);
    Object.keys(S.nodes).forEach(function (id) {
      var n = S.nodes[id];
      if (n.auto) out.push(['auto:' + id, n.auto]);
      if (n.type === 'modal') {
        if (n.confirmTarget) out.push(['ok:' + id, n.confirmTarget]);
        if (n.cancelTarget) out.push(['no:' + id, n.cancelTarget]);
      }
      // Один общий выход окна выбора контакта.
      if (n.type === 'contact_modal' && n.target) out.push(['target:' + id, n.target]);
      (n.buttons || []).forEach(function (b, i) {
        if (b.target) out.push(['btn:' + id + ':' + i, b.target]);
      });
    });
    return out;
  }

  function drawEdges(temp) {
    if (!edgesSvg) return;
    layer.querySelectorAll('.fl-input-slot').forEach(function(slot){slot.classList.remove('is-linked');});
    var d = '';
    edgeList().slice().sort(function(a,b){return Number(board && board.selected()===a[0])-Number(board && board.selected()===b[0]);}).forEach(function(e) {
      var p=portEl(e[0]); if(!p)return;
      var a=localPos(p),q=inPos(e[1],a,e[0]);if(!q)return;
      var selected=board && board.selected()===e[0], reconnecting=board && board.connecting()===e[0];
      if(!reconnecting)layer.querySelector('.fl-node[data-id="'+e[1]+'"] .fl-input-slot[data-side="'+q.side+'"]').classList.add('is-linked');
      d+='<g class="board-edge'+(selected?' is-selected':'')+(reconnecting?' is-reconnecting':'')+'"><path class="edge-hit" data-edge="'+esc(e[0])+'" d="'+curve(a,q)+'"/><path class="edge-line" d="'+curve(a,q)+'"/><circle cx="'+q.x+'" cy="'+q.y+'" r="'+(3/zoom)+'" class="edge-end"/><circle class="edge-end-hit" data-reconnect="'+esc(e[0])+'" cx="'+q.x+'" cy="'+q.y+'" r="'+(10/zoom)+'"/></g>';
    });
    if(temp)d+='<path class="is-temp" d="'+curve(temp.a,temp.b)+'"/>';
    edgesSvg.innerHTML=d;
  }

  function setTarget(key,target) { MaxBoard.target(S,key,target); }

  function applyTransform() {
    if(board) board.apply(); else layer.style.transform = 'translate(' + pan.x + 'px,' + pan.y + 'px) scale(' + zoom + ')';
  }

  /* ── взаимодействие с холстом ─────────────────────────────────────── */
  function initCanvas() {
    board=MaxBoard.create({viewport:viewport,layer:layer,state:function(){return S;},pos:pos,
      view:function(){return {pan:pan,zoom:zoom};},setView:function(p,z){pan=p;zoom=z;},
      port:portEl,localPos:localPos,inputPos:inPos,edges:edgeList,draw:drawEdges,snapshot:snapshot,
      rebuild:buildGraph,sync:syncPreview,save:save});
    var exact={},duplicates=[];
    allNodes().forEach(function(n){var p=pos(n.id),key=p.x+':'+p.y;if(exact[key])duplicates.push(n.id);else exact[key]=true;});
    board.repair(false,pendingPlacement.splice(0).concat(duplicates));

    var typingSnap = 0;
    MaxMessageMedia.installEditor({layer:layer,getNode:function(id){return id==='__meta' ? S.header : S.nodes[id];},commit:function(id,image){
      var isAvatar=id==='__meta';
      var target=isAvatar ? S.header : S.nodes[id];
      if(!target||(!isAvatar&&!['bot','user','person_chat'].includes(target.type)))return;
      var field=isAvatar ? 'avatar' : 'image';
      var next=clone(S),nextTarget=isAvatar ? next.header : next.nodes[id];
      if(image)nextTarget[field]=image;else delete nextTarget[field];
      // Check persistence before mutating the current scenario or undo history.
      if(!window.MaxStandalone)try{localStorage.setItem(STORE+':base',JSON.stringify(DEFAULT));localStorage.setItem(STORE,JSON.stringify(next));}
      catch(e){throw Error('Не удалось сохранить картинку: в браузере недостаточно места. Выберите изображение поменьше.');}
      snapshot();typingSnap=0;if(image)target[field]=image;else delete target[field];
      buildGraph();syncPreview();save();
      var label=layer.querySelector('[data-media-field="'+id+'"] .fl-media-drop');if(label)label.focus({preventScroll:true});
    }});
    layer.addEventListener('input', function (e) {
      var delayInput = e.target.closest('[data-delay-node]');
      if (delayInput) {
        if (Date.now() - typingSnap > 2000 || redoStack.length) { snapshot(); typingSnap = Date.now(); }
        var delayNode = S.nodes[delayInput.getAttribute('data-delay-node')];
        if (delayNode) {
          var seconds = Math.max(0, parseFloat(delayInput.value) || 0);
          delayNode.autoDelay = Math.round(seconds * 1000);
          save();
        }
        return;
      }
      var t = e.target.closest('[data-path]');
      if (!t) return;
      // снимок раз в две секунды, чтобы отмена не откатывала по букве
      if (Date.now() - typingSnap > 2000 || redoStack.length) { snapshot(); typingSnap = Date.now(); }
      var keys = t.getAttribute('data-path').split('.'), o = S;
      for (var i = 0; i < keys.length - 1; i++) o = o[keys[i]];
      o[keys[keys.length - 1]] = t.value;
      syncPreview(); save();
    });

    layer.addEventListener('change', function (e) {
      var ty = e.target.closest('[data-type]');
      if (ty) { changeType(ty.getAttribute('data-type'), ty.value); buildGraph(); syncPreview(); save(); return; }
    });

    layer.addEventListener('click', function (e) {
      var a = e.target.closest('[data-addbtn]');
      if (a) {
        var id = a.getAttribute('data-addbtn');
        snapshot();
        (S.nodes[id].buttons = S.nodes[id].buttons || []).push({ label: 'Кнопка', target: '' });
        buildGraph(); syncPreview(); save(); return;
      }
      var d = e.target.closest('[data-delbtn]');
      if (d) {
        var p = d.getAttribute('data-delbtn').split('|');
        snapshot();
        S.nodes[p[0]].buttons.splice(+p[1], 1);
        buildGraph(); syncPreview(); save(); return;
      }
      // Справочник контактов — общий, поэтому добавление и удаление строки
      // доступно прямо из карточки окна выбора контакта.
      var ac = e.target.closest('[data-addcontact]');
      if (ac) {
        snapshot();
        contacts().push({ id: 'contact_' + Date.now().toString(36), name: 'Новый контакт', status: '', avatar: '', unread: false });
        buildGraph(); syncPreview(); save(); return;
      }
      var dc = e.target.closest('[data-delcontact]');
      if (dc) {
        snapshot();
        contacts().splice(+dc.getAttribute('data-delcontact'), 1);
        buildGraph(); syncPreview(); save(); return;
      }
      var dp = e.target.closest('[data-dup]');
      if (dp) { dupNode(dp.getAttribute('data-dup')); buildGraph(); save(); return; }

      var x = e.target.closest('[data-del]');
      if (x) {
        var nid = x.getAttribute('data-del');
        var kindName = (KIND[(S.nodes[nid] || {}).type] || {}).label || 'узел';
        if (!window.confirm('Удалить «' + kindName + '»?\nОтменить можно кнопкой «Отменить» или Ctrl+Z.')) return;
        snapshot();
        delete S.nodes[nid];
        if (S.intro.auto === nid) S.intro.auto = '';
        Object.keys(S.nodes).forEach(function (k) {
          var n = S.nodes[k];
          if (n.auto === nid) n.auto = '';
          if (n.confirmTarget === nid) n.confirmTarget = '';
          if (n.cancelTarget === nid) n.cancelTarget = '';
          if (n.target === nid) n.target = '';
          (n.buttons || []).forEach(function (b) { if (b.target === nid) b.target = ''; });
        });
        buildGraph(); syncPreview(); save(); return;
      }
    });
  }

  function renameNode(oldId, raw) {
    var id = String(raw || '').trim().replace(/[^0-9A-Za-z_-]+/g, '_');
    if (!MaxSafety.identifier(id) || id === oldId || S.nodes[id]) return false;
    snapshot();
    var out = {};
    Object.keys(S.nodes).forEach(function (k) { out[k === oldId ? id : k] = S.nodes[k]; });
    S.nodes = out;
    if (S.intro.auto === oldId) S.intro.auto = id;
    Object.keys(S.nodes).forEach(function (k) {
      var n = S.nodes[k];
      if (n.auto === oldId) n.auto = id;
      if (n.confirmTarget === oldId) n.confirmTarget = id;
      if (n.cancelTarget === oldId) n.cancelTarget = id;
      if (n.target === oldId) n.target = id;
      (n.buttons || []).forEach(function (b) { if (b.target === oldId) b.target = id; });
    });
    return true;
  }

  // Смена типа сохраняет всё, что подходит новому типу, остальное добирает
  // значениями по умолчанию — чтобы не пересоздавать узел с нуля.
  function changeType(id, kind) {
    if (!window.confirm('Смена типа может удалить несовместимые поля и выходы. Продолжить?')) { buildGraph(); return; }
    snapshot();
    var n = S.nodes[id], o = { type: kind, x: n.x, y: n.y };
    if (kind !== 'modal' && kind !== 'external' && kind !== 'contact_modal') {
      o.auto = n.auto || '';
      if (n.autoDelay != null) o.autoDelay = n.autoDelay;
    }
    if (kind === 'bot') { o.text = n.text || 'Сообщение'; o.time = n.time || '09:41'; o.buttons = n.buttons || []; }
    if (kind === 'user') { o.text = n.text || 'Сообщение'; o.time = n.time || '09:41'; }
    if (kind === 'contact') { o.name = n.name || 'Иван Иванов'; o.sub = n.sub || 'Новый контакт'; o.time = n.time || '09:41'; }
    if (kind === 'modal') {
      o.title = n.title || 'Заголовок'; o.text = n.text || 'Описание';
      o.confirmLabel = n.confirmLabel || 'Да'; o.confirmTarget = n.confirmTarget || '';
      o.cancelLabel = n.cancelLabel || 'Отмена'; o.cancelTarget = n.cancelTarget || '';
    }
    if (kind === 'toast') { o.title = n.title || 'Готово'; o.sub = n.sub || ''; o.duration = milliseconds(n.duration,2500); }
    if (kind === 'external') { o.url = n.url || ''; o.repeatUrl = n.repeatUrl || ''; }
    if (kind === 'contact_modal') { o.target = n.target || ''; }
    if (kind === 'person_chat') {
      o.message = n.message || PERSON_MSG_DEFAULT; o.time = n.time || '16:10';
      o.contactSource = 'selected';
    }
    if (['bot','user','person_chat'].includes(kind) && n.image) o.image = clone(n.image);
    if (kind === 'payment') {
      o.price = n.price || '100 ₽'; o.members = n.members || '10';
      o.successDelay = milliseconds(n.successDelay,6000);
      if (n.doneTpl != null) o.doneTpl = n.doneTpl;
      for (const [field, , , fallback] of paymentCopy) o[field] = n[field] ?? fallback;
    }
    S.nodes[id] = o;
  }

  function dupNode(id) {
    snapshot();
    var n = clone(S.nodes[id]), i = 2, nid = id + '_copy';
    while (S.nodes[nid]) { nid = id + '_copy' + i++; }
    n.x = (n.x || 0) + 36; n.y = (n.y || 0) + 36;
    S.nodes[nid] = n; pendingPlacement.push(nid);
  }

  function addNode(kind) {
    var i = 1, id;
    do { id = kind + '_' + i++; } while (S.nodes[id]);
    var vr = viewport.getBoundingClientRect(), lr = layer.getBoundingClientRect();
    var x = Math.round((vr.width / 2 + vr.left - lr.left) / zoom) - 125;
    var y = Math.round((vr.height / 2 + vr.top - lr.top) / zoom) - 70;
    var n = { type: kind, x: x, y: y, auto: '' };
    if (kind === 'bot') { n.text = 'Новое сообщение'; n.time = '09:41'; n.buttons = []; }
    if (kind === 'user') { n.text = 'Сообщение от пользователя'; n.time = '09:41'; }
    if (kind === 'contact') { n.name = 'Иван Иванов'; n.sub = 'Новый контакт'; n.time = '09:41'; }
    if (kind === 'toast') { n.title = 'Готово'; n.sub = ''; n.duration = 2500; }
    if (kind === 'external') { delete n.auto; n.url = ''; n.repeatUrl = ''; }
    if (kind === 'payment') {
      n.price = '100 ₽'; n.members = '10'; n.successDelay = 6000;
      for (const [field, , , fallback] of paymentCopy) n[field] = fallback;
    }
    if (kind === 'modal') {
      delete n.auto;
      n.title = 'Заголовок'; n.text = 'Описание';
      n.confirmLabel = 'Да'; n.confirmTarget = '';
      n.cancelLabel = 'Отмена'; n.cancelTarget = '';
    }
    if (kind === 'contact_modal') { delete n.auto; n.target = ''; }
    if (kind === 'person_chat') {
      n.message = PERSON_MSG_DEFAULT; n.time = '16:10'; n.contactSource = 'selected';
    }
    snapshot();
    S.nodes[id] = n; pendingPlacement.push(id);
    if (kind === 'contact_modal') {
      // Measure and place the contact list before positioning its companion.
      // Both additions belong to the same undo snapshot.
      buildGraph();
      var chatIndex = 1, chatId;
      do { chatId = 'person_chat_' + chatIndex++; } while (S.nodes[chatId]);
      var sourceCard = layer.querySelector('.fl-node[data-id="' + id + '"]');
      S.nodes[chatId] = {
        type: 'person_chat', x: n.x + sourceCard.offsetWidth + 80, y: n.y,
        auto: '', message: PERSON_MSG_DEFAULT, time: '16:10', contactSource: 'selected'
      };
      n.target = chatId;
      pendingPlacement.push(chatId);
    }
    buildGraph(); if(board)board.reveal(id); save();
  }

  function fitView() { if(board) board.fit(); }

  function setView(mode) {
    if(board){board.layout();board.cancel();}
    document.body.classList.remove('view-split', 'view-flow', 'view-preview');
    document.body.classList.add('view-' + mode);
    $$('[data-view]').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-view') === mode);
    });
    if(board)board.layout();
    setTimeout(drawEdges, 60);
  }

  /* ── старт ────────────────────────────────────────────────────────── */
  function init() {
    feed = $('.chat-scroll');
    overlay = $('#shareModal');
    $$('.nav-item').forEach(function(item){if(!['Контакты','Звонки'].includes(item.textContent.trim()))item.remove();});

    renderChrome();
    restart();

    var messageInput = $('.wb-input'), writebar = $('.writebar');
    var sendButton = document.createElement('button');
    sendButton.type = 'button';sendButton.className = 'wb-send';
    sendButton.setAttribute('aria-label', 'Отправить сообщение');
    sendButton.innerHTML = '<img class="send-mobile" src="assets/send-mobile.svg" alt=""><img class="send-desktop" src="assets/send-desktop.svg" alt="">';
    $('.wb-card').appendChild(sendButton);
    function updateComposer() {
      var ready = !!messageInput.value.trim();
      writebar.classList.toggle('has-text', ready);sendButton.hidden = !ready;
    }
    function sendMessage() {
      var text = messageInput.value.trim();if (!text) return;
      var message = {type:'user',typed:true,text:text,time:new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})};
      trail.push(message);
      if(activeChat === 'person' && personChat) (personChat.messages || (personChat.messages = [])).push(message);
      else if(botTrail) botTrail = trail.slice();
      messageInput.value = '';updateComposer();renderFeed();messageInput.focus({preventScroll:true});
    }
    messageInput.addEventListener('input', updateComposer);
    messageInput.addEventListener('keydown', function(e) {
      if(e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !e.shiftKey) { e.preventDefault();sendMessage(); }
    });
    sendButton.addEventListener('click', sendMessage);updateComposer();

    feed.addEventListener('click', feedClick);
    $('#payClose').addEventListener('click', function () { closePay(); });
    $$('.pay-cell').forEach(function (c) {
      c.addEventListener('click', function () { setMethod(c.getAttribute('data-method')); });
    });
    $('#payPay').addEventListener('click', payNow);
    $('#payOverlay').addEventListener('click', function (e) {
      if (e.target === $('#payOverlay')) closePay();
    });
    $('#mConfirm').addEventListener('click', function () { closeModal('ok'); });
    $('#mCancel').addEventListener('click', function () { closeModal('no'); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });

    // Заголовок окна выбора контакта — константа в коде, а не поле сценария.
    var pt = $('#pickTitle'); if (pt) pt.textContent = PICK_TITLE;
    var pOv = $('#pickOverlay');
    if (pOv) {
      pOv.addEventListener('click', function (e) {
        var row = e.target.closest('[data-pick]');
        if (row) { pickContact(row.getAttribute('data-pick')); return; }
        var tab = e.target.closest('[data-tab]');
        if (tab) { pickTab = tab.getAttribute('data-tab'); renderPick(); return; }
        if (e.target.closest('#pickClose') || e.target === pOv) closePick();
      });
    }
    var pInp = $('#pickInput');
    if (pInp) pInp.addEventListener('input', function () { pickQuery = pInp.value; renderPick(); });

    // Навигация между чатами не меняет граф сценария:
    // клик по боту возвращает к сохранённой переписке, клик по контакту —
    // снова открывает личный чат.
    var botCell = $('#cellBot');
    if (botCell) botCell.addEventListener('click', function () {
      $('.app').classList.remove('is-chat-list');
      if (personChat && activeChat !== 'bot') switchToBotChat();
    });
    var chatList = $('.chat-list');
    if (chatList) chatList.addEventListener('click', function (e) {
      var p = e.target.closest('#cellPerson');
      if(p)$('.app').classList.remove('is-chat-list');
      if (p && activeChat !== 'person') switchToPersonChat();
    });

    // «Назад» из личного чата делает то же самое, что клик по боту в списке.
    var back = $('.tb-back');
    if (back) back.addEventListener('click', function () {
      if($('.app').clientWidth<972){$('.app').classList.add('is-chat-list');return;}
      if (personChat && activeChat === 'person') switchToBotChat();
    });

    document.addEventListener('keydown', function (e) {
      if(e.key==='Tab'){
        if(document.querySelector('.prototype-boundary:not([hidden]),.message-image-viewer:not([hidden])'))return;
        var dialogs=$$('.modal-overlay.is-open,.pay-overlay.is-open,.pick-overlay.is-open');
        var current=dialogs.find(function(d){return d.contains(document.activeElement);})||(!EDIT?dialogs[dialogs.length-1]:null);
        if(current){var controls=Array.from(current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')).filter(function(el){return el.getClientRects().length;});
          var first=controls[0],last=controls[controls.length-1];if(first&&(!current.contains(document.activeElement)||(e.shiftKey?document.activeElement===first:document.activeElement===last))){e.preventDefault();(e.shiftKey?last:first).focus();}}
        return;
      }
      if (e.key !== 'Escape') return;
      var pk = $('#pickOverlay');
      if (pk && pk.classList.contains('is-open')) closePick();
      else if (overlay.classList.contains('is-open')) closeModal();
      else if ($('#payOverlay').classList.contains('is-open')) closePay();
    });

    imageViewer = MaxMessageMedia.installViewer({feed:feed,getNode:function(id){return S.nodes[id];},author:function(node){return {name:node.type==='bot'?S.header.name:'Вы',avatar:node.type==='bot'?botAvatar():'',date:S.intro.date||''};}});
    if (!/[?&]edit(=1)?(&|$)/.test(window.MaxStandalone?.search??location.search)) return;

    document.body.classList.add('is-editing');
    layer = $('#flLayer');
    viewport = $('#flView');
    buildGraph();
    applyTransform();
    initCanvas();
    setView('split');
    if (fromDraft) $('#flDraft').hidden = false;
    MaxAuthor.install(bundle, function(){ return clone(S); }, function(next){ snapshot(); S=clone(next); clearTimers(); buildGraph(); renderChrome(); restart(); save(); }, function(key,target){ snapshot(); setTarget(key,target); buildGraph(); syncPreview(); save(); });
    window.addEventListener('pagehide', function(){ if(saveTimer) flushDraft(); });
    $('#flDownload').textContent='HTML';
    if(!window.MaxStandalone){var zipButton=document.createElement('button');zipButton.className='fl-t';zipButton.textContent='Комплект ZIP';zipButton.onclick=function(){MaxAuthor.exportBundle(bundle,S);};$('.fl-bar').append(zipButton);}
    MaxEditorUI.install();updateHistory();

    $$('[data-add]').forEach(function(b){b.addEventListener('click',function(){addNode(b.getAttribute('data-add'));});});
    $$('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
    });
    $('#flFit')?.addEventListener('click', fitView);
    $('#flRestart').addEventListener('click', restart);

    $('#flDownload').addEventListener('click', async function(){var button=this;button.disabled=true;try{MaxAuthor.status('Собирается HTML…');await MaxHTML.exportHTML(bundle,S);}catch(e){MaxAuthor.status('Экспорт не выполнен: '+e.message,true);}finally{button.disabled=false;}});
    $('#flUndo').addEventListener('click', undo);
    $('#flRedo').addEventListener('click', redo);
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.code === 'KeyZ' || String(e.key).toLowerCase() === 'z') &&
          !e.target.closest('input,textarea,[contenteditable]:not([contenteditable="false"])')) { e.preventDefault(); if(e.shiftKey)redo();else undo(); }
    });
    setTimeout(fitView, 120);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
