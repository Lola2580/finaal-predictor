/* =========================================================
   CONFIG
   ========================================================= */
const supabaseUrl = "https://xujisqauxmqiwdazphpn.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1amlzcWF1eG1xaXdkYXpwaHBuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk4MjQ4NjIsImV4cCI6MjA4NTQwMDg2Mn0.5HGJsneJvntry-wKpz2wDd5MKe_CDACd99VKaMdrEd0";

const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);

const API_URL = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";

/* =========================================================
   STATE
   ========================================================= */
let liveResults = [];
let autoFetch;
let timerInterval;
let driftCheckInterval;
let isFetching = false;
let lastKnownPeriod = null;
let gotNewDataThisMinute = false;
let serverTimeOffset = 0;
let lastSyncTime = 0;

/* =========================================================
   ⭐ NUMBER COLOR MAPPING
   ========================================================= */
// 1, 3, 7, 9 → Green
// 2, 4, 6, 8 → Red
// 5 → Green + Purple mix
// 0 → Red + Purple mix
const NUMBER_COLORS = {
  '1': 'num-green',
  '2': 'num-red',
  '3': 'num-green',
  '4': 'num-red',
  '5': 'num-green-purple',
  '6': 'num-red',
  '7': 'num-green',
  '8': 'num-red',
  '9': 'num-green',
  '0': 'num-red-purple'
};

function getNumberColor(num){
  return NUMBER_COLORS[String(num)] || 'num-red';
}

/* Helper: number badges HTML banao */
function buildNumberBadges(numbers){
  return numbers.map(n =>
    `<span class="num-badge ${getNumberColor(n)}">${n}</span>`
  ).join('');
}

/* =========================================================
   SERVER TIME SYNC
   ========================================================= */
async function syncServerTime(){
  try{
    // 1. Pehle Lottery API se time nikaalne ki koshish karo
    const t0 = Date.now();
    const res = await fetch(API_URL + "?t=" + t0);
    const t1 = Date.now();
    const serverDate = res.headers.get('date');
    
    if(serverDate){
      const serverMs = new Date(serverDate).getTime();
      serverTimeOffset = serverMs + (t1 - t0)/2 - t1;
      lastSyncTime = Date.now();
      console.log('⏰ Synced via Lottery API. Offset:', serverTimeOffset, 'ms');
      return;
    }
    throw new Error('No date header from API');
  } catch(e){
    console.log('Primary time sync failed, fallback to TimeAPI.io...');
    await syncViaTimeAPI();
  }
}

async function syncViaTimeAPI(){
  try{
    const t0 = Date.now();
    // 2. TimeAPI.io fallback (WorldTimeAPI ki jagah)
    const res = await fetch("https://timeapi.io/api/Time/current/zone?timezone=UTC");
    
    if(!res.ok) throw new Error("TimeAPI failed");
    
    const t1 = Date.now();
    const json = await res.json();
    
    const serverMs = new Date(json.dateTime).getTime();
    serverTimeOffset = serverMs + (t1 - t0)/2 - t1;
    lastSyncTime = Date.now();
    console.log('⏰ Synced via TimeAPI.io. Offset:', serverTimeOffset, 'ms');
    
  } catch(e){
    // 3. Agar sab fail ho jaye to Local Time use karo
    console.log('⚠️ Time sync failed — using local time');
    serverTimeOffset = 0;
  }
}

function getNow(){ return new Date(Date.now() + serverTimeOffset); }
function getRealSecond(){ return getNow().getSeconds(); }

function getRemainingTime(){
  const now = getNow();
  const sec = now.getSeconds();
  const ms = now.getMilliseconds();
  const remainingMs = (59 - sec) * 1000 + (1000 - ms);
  const totalSec = Math.ceil(remainingMs / 1000);
  return {
    mm: String(Math.floor(totalSec / 60)).padStart(2, '0'),
    ss: String(totalSec % 60).padStart(2, '0'),
    totalSec: totalSec
  };
}

/* =========================================================
   TIMER
   ========================================================= */
function startRealTimer(){
  clearInterval(timerInterval);
  let lastBeepSec = null;
  timerInterval = setInterval(()=>{
    const t = getRemainingTime();
    document.getElementById("timerText").innerText = t.mm + ":" + t.ss;
    
    const timerEl = document.getElementById("timer");
    if(t.totalSec <= 10){ timerEl.classList.add("urgent"); }
    else { timerEl.classList.remove("urgent"); }
    
    // Last 5 sec me beep
    if(t.totalSec <= 5 && t.totalSec > 0 && lastBeepSec !== t.totalSec){
      lastBeepSec = t.totalSec;
      if(document.getElementById("beepToggle").checked){
        try{
          const sound = document.getElementById("beepSound");
          sound.currentTime = 0;
          sound.play().catch(()=>{});
          setTimeout(()=>sound.pause(), 180);
        }catch(e){}
      }
    }
    if(t.totalSec > 10) lastBeepSec = null;
  }, 100);
}

/* =========================================================
   SMART POLLING
   ========================================================= */
function startSmartPolling(){
  clearInterval(autoFetch);
  autoFetch = setInterval(async ()=>{
    const sec = getRealSecond();
    if(sec === 0) gotNewDataThisMinute = false;
    
    // Sirf :55 se :01 ke beech API call karo
    const inWindow = (sec >= 55 || sec <= 1);
    if(!inWindow) return;
    if(gotNewDataThisMinute) return;
    if(isFetching) return;
    
    await fetchData();
  }, 500);
}

/* =========================================================
   INIT
   ========================================================= */
async function initApp(){
  clearInterval(autoFetch);
  clearInterval(timerInterval);
  clearInterval(driftCheckInterval);
  
  await syncServerTime();
  startRealTimer();
  await fetchData();
  startSmartPolling();
  
  // Har 10 min me time re-sync (drift fix)
  driftCheckInterval = setInterval(async ()=>{
    if(Date.now() - lastSyncTime > 10 * 60 * 1000){
      console.log('🔄 Re-syncing time (drift fix)...');
      await syncServerTime();
    }
  }, 60 * 1000);
}

/* =========================================================
   FETCH DATA
   ========================================================= */
async function fetchData(force = false){
  if(isFetching && !force) return;
  isFetching = true;
  
  try{
    const res = await fetch(API_URL + "?t=" + Date.now());
    const json = await res.json();
    
    if(!json.data?.list){ isFetching = false; return; }
    
    const results = json.data.list.map(r=>({
      period: r.issueNumber,
      digit: r.number,
      bigSmall: parseInt(r.number) >= 5 ? "Big" : "Small"
    }));
    
    const latest = results.slice(0, 10);
    const newPeriod = latest[0]?.period;
    
    if(newPeriod && newPeriod !== lastKnownPeriod){
      lastKnownPeriod = newPeriod;
      liveResults = latest;
      updateTable();
      await addPrediction(results);
      gotNewDataThisMinute = true;
    } else if(force){
      liveResults = latest;
      updateTable();
    }
  } catch(e){ 
    console.log('Fetch error:', e); 
  }
  
  isFetching = false;
}

/* =========================================================
   MANUAL REFRESH
   ========================================================= */
async function manualRefresh(){
  const btn = document.getElementById("refreshBtn");
  btn.classList.add("spinning");
  
  try{
    await syncServerTime(); // Time bhi sync karo
    await fetchData(true);  // Data force fetch karo
  } catch(e){ 
    console.log(e); 
  }
  
  setTimeout(()=>btn.classList.remove("spinning"), 700);
}

/* =========================================================
   TABLE (Big/Small same color as number)
   ========================================================= */
function updateTable(){
  const tbody = document.getElementById("liveResults");
  tbody.innerHTML = "";
  
  liveResults.forEach(r=>{
    const numColor = getNumberColor(r.digit);
    // Big/Small badge ko bhi number ka hi color de rahe hain
    tbody.innerHTML += `<tr>
      <td>${r.period}</td>
      <td><span class="num-badge ${numColor}">${r.digit}</span></td>
      <td><span class="bs-badge ${numColor}">${r.bigSmall}</span></td>
    </tr>`;
  });
}

/* =========================================================
   SAVE + PREDICT
   ========================================================= */
async function addPrediction(results){
  if(results.length < 6) return;
  const seq = results.slice(1, 6).map(r=>r.digit).join('');
  const next = results[0].digit;
  await saveData(seq, next);
  await autoPredict(results);
}

async function saveData(seq, next){
  const { data } = await supabaseClient
    .from('predictions')
    .select('next_numbers')
    .eq('sequence', seq)
    .maybeSingle();
    
  if(data){
    let arr = data.next_numbers.split(',');
    if(!arr.includes(next)){
      arr.push(next);
      await supabaseClient.from('predictions')
        .update({ next_numbers: arr.join(',') })
        .eq('sequence', seq);
    }
  } else {
    await supabaseClient.from('predictions')
      .insert([{ sequence: seq, next_numbers: next }]);
  }
}

/* =========================================================
   AUTO PREDICT
   ========================================================= */
async function autoPredict(results){
  const seq = results.slice(0, 5).map(r=>r.digit).join('');
  const { data } = await supabaseClient
    .from('predictions')
    .select('*')
    .eq('sequence', seq)
    .maybeSingle();

  const predEl = document.getElementById("predictionText");

  if(data){
    const nums = data.next_numbers.split(',');
    predEl.innerHTML = buildNumberBadges(nums);
    predEl.className = "prediction-display has-prediction";

    if(document.getElementById("beepToggle").checked){
      try{
        let sound = document.getElementById("beepSound");
        sound.currentTime = 0;
        sound.play().catch(()=>{});
        setTimeout(()=>sound.pause(), 3000);
      }catch(e){}
    }
  } else {
    predEl.innerText = "No Trade";
    predEl.className = "prediction-display none";
  }
}

/* =========================================================
   MANUAL SEARCH
   ========================================================= */
async function manualSearch(){
  const seq = document.getElementById("manualSeq").value.trim();
  if(!seq) return;
  
  const { data } = await supabaseClient
    .from('predictions')
    .select('*')
    .eq('sequence', seq)
    .maybeSingle();
    
  if(data){
    const nums = data.next_numbers.split(',');
    document.getElementById("manualResult").innerHTML =
      `<div>Found ✅ Next:</div>
       <div class="search-numbers">${buildNumberBadges(nums)}</div>`;
  } else {
    document.getElementById("manualResult").innerText = "No Data Found ❌";
  }
}

/* 🚀 START APP */
initApp();
