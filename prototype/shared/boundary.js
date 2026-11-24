/* UI-only destinations agreed by the user. Never intercept scenario buttons. */
(function(){
 'use strict';
 let panel,opener,host,blocked=[];
 function build(){
  host=document.querySelector('.app')||document.body;
  panel=document.createElement('section');panel.className='prototype-boundary';panel.id='prototypeBoundary';panel.hidden=true;
  panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','prototypeBoundaryTitle');panel.setAttribute('aria-describedby','prototypeBoundaryDescription');
  panel.innerHTML='<div class="prototype-boundary__content"><div class="prototype-boundary__symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m8 3-5 5 5 5M3 8h11a7 7 0 0 1 0 14h-3"/></svg></div><h1 id="prototypeBoundaryTitle">Вернёмся к сценарию?</h1><p id="prototypeBoundaryDescription">Этот раздел не входит в текущий прототип.</p><button class="prototype-boundary__back" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5-7 7 7 7M3 12h17"/></svg>Вернуться назад</button></div>';
  panel.querySelector('button').addEventListener('click',close);host.append(panel);
 }
 function open(trigger){
  if(!panel)build();if(!panel.hidden)return;
  panel.inert=false;
  opener=trigger||document.activeElement;
  blocked=Array.from(host.children).filter(el=>el!==panel&&!el.inert);blocked.forEach(el=>{el.inert=true;});
  panel.hidden=false;panel.querySelector('button').focus({preventScroll:true});
 }
 function close(){
  if(!panel||panel.hidden)return;
  panel.hidden=true;blocked.forEach(el=>{el.inert=false;});blocked=[];
  if(opener?.isConnected)opener.focus({preventScroll:true});
 }
 window.MaxBoundary={open,close};
 function pending(target){
  if(target.closest('#flow,.prototype-boundary'))return false;
  if(!target.closest('.app'))return false;
  if(target.matches('.nav-item'))return ['Звонки','Контакты'].includes(target.textContent.trim());
  return target.matches('.tb-btn,.wb-ico,.wb-voice,.list-add,.list-search,.pay-promo-btn,.contact-act[aria-label="Написать сообщение"]')||
    !!target.closest('.pay-overlay a,.chat-scroll a');
 }
 document.addEventListener('click',function(e){
  const target=e.target.closest('button,a,.list-search');
  if(target&&pending(target)){e.preventDefault();e.stopImmediatePropagation();open(target);}
 },true);
 document.addEventListener('keydown',function(e){
  if(panel&&!panel.hidden){
   if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();}
   if(e.key==='Tab'){e.preventDefault();e.stopImmediatePropagation();panel.querySelector('button').focus();}
  }else if((e.key==='Enter'||e.key===' ')&&e.target.matches('.list-search')){e.preventDefault();open(e.target);}
 },true);
 function ready(){document.querySelectorAll('.list-search').forEach(el=>{el.setAttribute('role','button');el.tabIndex=0;el.setAttribute('aria-label','Поиск по чатам');});}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
})();
