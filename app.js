const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyqpppW2wnxH4nAYrZDaIu0XedFB5wfOeUXXokxFz4TpslB-GqD24B9GsPp0i_nTJ4GVA/exec';
 
const TRAINER_CHAT_ID = '739299264';

let tg;
let workoutData = [];
let completedCount = 0;
let totalExercises = 0;
 
try {
    tg = window.Telegram.WebApp;
    tg.ready();
    tg.expand();
    // НЕ блокируем вертикальный свайп — пользователь должен иметь возможность свернуть мини-апп жестом.
    // (раньше вызывали tg.disableVerticalSwipes() и tg.requestFullscreen() — это мешало)
    // Отступ сверху, чтобы контент не залезал под Telegram-шапку (Закрыть/▼/⋯).
    // Bot API 8.0+: tg.contentSafeAreaInset.top даёт точное значение. Старые версии — fallback 56px.
    function applyTelegramTopInset() {
        var top = 0;
        try {
            if (tg.isFullscreen === true) {
                top = (tg.contentSafeAreaInset && tg.contentSafeAreaInset.top) || 0;
            } else if (tg.contentSafeAreaInset && typeof tg.contentSafeAreaInset.top === 'number') {
                top = tg.contentSafeAreaInset.top;
            } else {
                top = 56; // запас под Telegram-шапку на iPhone
            }
        } catch (_) { top = 56; }
        document.documentElement.style.setProperty('--tg-top-pad', top + 'px');
    }
    applyTelegramTopInset();
    // Обновляем при изменении viewport / fullscreen
    try {
        if (typeof tg.onEvent === 'function') {
            tg.onEvent('viewportChanged', applyTelegramTopInset);
            tg.onEvent('contentSafeAreaChanged', applyTelegramTopInset);
            tg.onEvent('fullscreenChanged', applyTelegramTopInset);
        }
    } catch (_) {}
} catch (e) {
    console.error('Telegram WebApp not loaded:', e);
    tg = {
        initDataUnsafe: { user: { id: '739299264' } },
        showAlert: (msg) => alert(msg),
        openLink: (url) => window.open(url, '_blank'),
        openTelegramLink: (url) => window.open(url, '_blank'),
        HapticFeedback: null
    };
}
 
document.addEventListener('DOMContentLoaded', init);
 
var clientName = '';
var weekTitle = '';

async function init() {
    console.log('Init started...');
    try {
        const response = await loadWorkoutData();
        console.log('Data received:', response);
        clientName = response.clientName || '';
        weekTitle = response.weekTitle || '';
        if (response.weekTitle) {
            const weekNum = response.weekTitle.replace('Неделя ', '');
            document.getElementById('week-number').textContent = weekNum;
        }
        workoutData = response.days || [];
        totalExercises = 0;
        completedCount = 0;
        workoutData.forEach(day => {
            day.exercises.forEach(exercise => {
                totalExercises++;
                if (exercise.weightFact || exercise.repsFact) {
                    completedCount++;
                }
            });
        });
        renderWorkout();
        renderHome();
        // Подгружаем рекорды и вес в фоне (для карточек на главной)
        loadHomeExtras();
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('main-screen').classList.remove('hidden');
        initializeTabs();
        initAdminTab();
        // Опрос самочувствия — один раз при первом входе в тренировку.
        // Если клиент закроет/пропустит — считается «Бодрый», веса как есть.
        if (!wellnessAsked && workoutData.length > 0) {
            wellnessAsked = true;
            setTimeout(openWellnessModal, 400);
        }
    } catch (error) {
        console.error('ERROR:', error);
        document.getElementById('loading').innerHTML =
            '<div style="color: red; padding: 20px; text-align: center;">' +
            '<h3>Ошибка загрузки</h3>' +
            '<p>' + error.message + '</p>' +
            '<button onclick="location.reload()" style="padding: 10px 20px; margin-top: 10px;">Перезагрузить</button>' +
            '</div>';
    }
}
 
async function loadWorkoutData() {
    var chatId = tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : '739299264';
    var url = APPS_SCRIPT_URL + '?action=read&chatId=' + chatId;
    var response = await fetch(url);
    if (!response.ok) throw new Error('HTTP error ' + response.status);
    var data = await response.json();
    if (data.error) throw new Error(data.error);
    return data;
}
 
function renderWorkout() {
    var container = document.getElementById('exercises-container');
    container.innerHTML = '';
    workoutData.forEach(function(day, dayIndex) {
        // Считаем выполненные упражнения в этом дне
        var dayCompleted = 0;
        var dayTotal = day.exercises.length;
        day.exercises.forEach(function(ex) {
            if (ex.weightFact || ex.repsFact) dayCompleted++;
        });
        var dayDone = dayCompleted === dayTotal && dayTotal > 0;

        // Заголовок дня (кликабельный)
        var dayHeader = document.createElement('div');
        dayHeader.className = 'day-header day-collapsible';
        dayHeader.dataset.dayIndex = dayIndex;
        dayHeader.innerHTML = '<span class="day-title">' + day.day + '</span>' +
            '<span class="day-status">' +
                '<span class="day-counter">' + dayCompleted + '/' + dayTotal + '</span>' +
                (dayDone ? ' ✅' : '') +
                '<span class="day-chevron">▼</span>' +
            '</span>';
        container.appendChild(dayHeader);

        // Контейнер упражнений (сворачиваемый)
        var dayBody = document.createElement('div');
        dayBody.className = 'day-body';
        dayBody.id = 'day-body-' + dayIndex;
        day.exercises.forEach(function(exercise, exIndex) {
            var card = createExerciseCard(exercise, dayIndex, exIndex);
            dayBody.appendChild(card);
        });
        container.appendChild(dayBody);

        // Клик по заголовку — свернуть/развернуть
        dayHeader.addEventListener('click', function() {
            var body = document.getElementById('day-body-' + this.dataset.dayIndex);
            var chevron = this.querySelector('.day-chevron');
            var isCollapsed = body.classList.toggle('collapsed');
            this.classList.toggle('collapsed', isCollapsed);
            chevron.textContent = isCollapsed ? '▶' : '▼';
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
        });
    });
    updateProgress();
}
 
function createExerciseCard(exercise, dayIndex, exIndex) {
    var card = document.createElement('div');
    card.className = 'exercise-card';
    var videoStr = exercise.video != null ? String(exercise.video) : '';
    var hasVideo = videoStr && (videoStr.indexOf('http') !== -1 || videoStr.indexOf('📽️') !== -1);
    var photo1 = exercise.photo1 || '';
    var photo2 = exercise.photo2 || '';
    var photoHtml1 = photo1 ? '<img src="' + photo1 + '" alt="Photo 1" class="exercise-photo-img" onerror="this.parentElement.innerHTML=\'🏋️\'">' : '🏋️';
    var photoHtml2 = photo2 ? '<img src="' + photo2 + '" alt="Photo 2" class="exercise-photo-img" onerror="this.parentElement.innerHTML=\'💪\'">' : '💪';
    var noteHtml = exercise.note ? '<div class="trainer-note">💬 ' + exercise.note + '</div>' : '';
    var videoHtml = hasVideo ? '<button class="video-btn" onclick="openVideo(\'' + videoStr + '\')">📹 ВИДЕО ТЕХНИКИ</button>' : '';
    var commentValue = exercise.comment || '';
    if (commentValue && /^\d{4}-\d{2}-\d{2}T/.test(commentValue)) commentValue = '';
    if (commentValue && /^\d{2}\.\d{2}\.\d{4}/.test(commentValue)) commentValue = '';

    // Вес: с учётом самочувствия (если уставший/приболел — снижаем для отображения)
    var baseWeight = exercise.weightPlan;
    var todayWeight = getDisplayWeight(baseWeight);
    var weightAdjusted = (baseWeight && todayWeight !== baseWeight);
    var weightHtml = weightAdjusted
        ? todayWeight + 'кг <small class="weight-adj">(было ' + baseWeight + ')</small>'
        : (baseWeight || '—') + 'кг';

    // Прозрачность: показать что было в прошлый раз для контекста прогрессии
    var lastSessionHtml = '';
    if (exercise.lastSession && exercise.lastSession.weight) {
        var ls = exercise.lastSession;
        var fbEmoji = '';
        var fbInfo = RPE_FEEDBACK_MAP[ls.feedback];
        if (fbInfo) fbEmoji = ' ' + fbInfo.emoji;
        var dateStr = ls.date ? ' (' + ls.date + ')' : '';
        lastSessionHtml = '<div class="last-session-info">📊 Прошлый раз: ' +
            ls.weight + ' × ' + ls.reps + fbEmoji + dateStr +
            '</div>';
    }

    card.innerHTML =
        '<div class="exercise-photos">' +
            '<div class="exercise-photo">' + photoHtml1 + '</div>' +
            '<div class="exercise-photo">' + photoHtml2 + '</div>' +
        '</div>' +
        '<div class="exercise-body">' +
            '<div class="exercise-name">' + exercise.exercise + '</div>' +
            noteHtml +
            lastSessionHtml +
            '<div class="exercise-params">' +
                '<div class="param"><div class="param-label">Подх</div><div class="param-value">' + exercise.sets + '</div></div>' +
                '<div class="param"><div class="param-label">Повт</div><div class="param-value">' + exercise.reps + '</div></div>' +
                '<div class="param"><div class="param-label">Вес</div><div class="param-value plan">' + weightHtml + '</div></div>' +
                '<div class="param"><div class="param-label">RPE</div><div class="param-value rpe">' + exercise.rpe + '</div></div>' +
            '</div>' +
            videoHtml +
            '<div class="input-row">' +
                '<input type="number" inputmode="decimal" enterkeyhint="done" class="input-field" placeholder="Вес (кг)" value="' + (exercise.weightFact || '') + '" data-day="' + dayIndex + '" data-exercise="' + exIndex + '" data-row="' + exercise.rowIndex + '" data-field="weight" onchange="handleInput(this)">' +
                '<input type="number" inputmode="numeric" enterkeyhint="done" class="input-field" placeholder="Повторения" value="' + (exercise.repsFact || '') + '" data-day="' + dayIndex + '" data-exercise="' + exIndex + '" data-row="' + exercise.rowIndex + '" data-field="reps" onchange="handleInput(this)">' +
            '</div>' +
            '<textarea class="comment-field" placeholder="Комментарий к упражнению (опционально)" data-day="' + dayIndex + '" data-exercise="' + exIndex + '" data-row="' + exercise.rowIndex + '" data-field="comment" onchange="handleInput(this)">' + commentValue + '</textarea>' +
            '<div class="rpe-feedback-row" id="rpe-row-' + dayIndex + '-' + exIndex + '">' +
                renderRpeButton(exercise, dayIndex, exIndex) +
            '</div>' +
        '</div>';
    return card;
}

// ─── Самочувствие клиента (per session, спрашивается при входе) ────────
var WELLNESS_MAP = {
    good:  { multiplier: 1.00, emoji: '💪', label: 'Бодрый',     factor: '' },
    tired: { multiplier: 0.90, emoji: '😴', label: 'Устал',      factor: '−10%' },
    sick:  { multiplier: 0.85, emoji: '🤧', label: 'Приболел',   factor: '−15%' },
    pms:   { multiplier: 0.90, emoji: '🩸', label: 'ПМС',        factor: '−10%' }
};
var sessionWellness = 'good';
var wellnessAsked = false;

function getWellnessMultiplier() {
    var w = WELLNESS_MAP[sessionWellness];
    return w ? w.multiplier : 1.0;
}

function openWellnessModal() {
    document.getElementById('wellness-modal').classList.remove('hidden');
}
function closeWellnessModal() {
    document.getElementById('wellness-modal').classList.add('hidden');
}
function setWellness(kind) {
    sessionWellness = WELLNESS_MAP[kind] ? kind : 'good';
    closeWellnessModal();
    updateWellnessBanner();
    // Перерисовать все дни с новыми весами (мультипликатор изменился)
    if (workoutData && workoutData.length) renderAllDaysIfNeeded();
    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
}
function skipWellness() {
    setWellness('good');
}

function updateWellnessBanner() {
    var b = document.getElementById('wellness-banner');
    if (!b) return;
    if (sessionWellness === 'good') {
        b.classList.add('hidden');
        return;
    }
    var info = WELLNESS_MAP[sessionWellness];
    b.classList.remove('hidden');
    b.innerHTML = info.emoji + ' ' + info.label +
                  ' — рекомендуемые веса снижены на ' + info.factor +
                  ' <button class="wellness-banner-edit" onclick="openWellnessModal()">изменить</button>';
}

// Перерисовка дней — поддержка обновления весов после смены самочувствия
function renderAllDaysIfNeeded() {
    if (typeof renderWorkout === 'function') renderWorkout();
}

// Разобрать вес: понимает «80», «80.5», «80-90», «80,5 - 90» → {min, max}
function _parseWeightRange(s) {
    if (s == null) return null;
    var str = s.toString().replace(',', '.').trim();
    var nums = str.match(/[0-9]+(?:\.[0-9]+)?/g);
    if (!nums || nums.length === 0) return null;
    var min = parseFloat(nums[0]);
    var max = nums.length > 1 ? parseFloat(nums[nums.length - 1]) : min;
    if (isNaN(min)) return null;
    if (isNaN(max)) max = min;
    return { min: min, max: max };
}

// Применить самочувствие к плановому весу для отображения клиенту.
// Логика:
//   «Бодрый» (mult=1.0)     → план без изменений (как написал тренер, например «80-90»)
//   «Устал» / «Приболел» / «ПМС» (mult<1) → нижняя граница × mult (со скидкой), округление до 0.5кг
// Если weightPlan — одиночное число, используем его как min=max.
function getDisplayWeight(weightPlan) {
    var mult = getWellnessMultiplier();
    // Бодрый — ничего не трогаем, отдаём план как есть
    if (mult >= 1) return weightPlan;
    var range = _parseWeightRange(weightPlan);
    if (!range) return weightPlan; // нечисловое значение — оставляем как есть
    // Со снижением — нижняя граница диапазона × мультипликатор, округление до 0.5кг
    return Math.round(range.min * mult * 2) / 2;
}

// ─── RPE-фидбэк (после каждого упражнения, опционально) ───────────────
var RPE_FEEDBACK_MAP = {
    easy:   { rpe: 5.5, emoji: '😌', label: 'Легко' },
    normal: { rpe: 7.5, emoji: '💪', label: 'Норм' },
    hard:   { rpe: 9,   emoji: '🔥', label: 'Тяжело' },
    failed: { rpe: 10,  emoji: '❌', label: 'Не вытянул' }
};
var FAIL_REASON_LABELS = {
    too_hard: 'слишком тяжело',
    sleep:    'плохо спал',
    illness:  'плохо себя чувствовал',
    stress:   'стресс',
    food:     'мало еды/энергии'
};
var rpeModalCtx = null;

// Рендер кнопки-индикатора фидбэка для карточки упражнения
function renderRpeButton(exercise, dayIndex, exIndex) {
    var fb = exercise.feedback || '';
    if (fb && RPE_FEEDBACK_MAP[fb]) {
        var info = RPE_FEEDBACK_MAP[fb];
        return '<button class="rpe-feedback-btn rpe-set rpe-' + fb + '" ' +
               'onclick="openRpeModal(' + dayIndex + ',' + exIndex + ')">' +
               info.emoji + ' ' + info.label + ' • тап чтобы изменить' +
               '</button>';
    }
    return '<button class="rpe-feedback-btn" ' +
           'onclick="openRpeModal(' + dayIndex + ',' + exIndex + ')">' +
           '+ Как было упражнение?' +
           '</button>';
}

// Обновляет кнопку фидбэка в DOM после изменения
function refreshRpeButton(dayIndex, exIndex) {
    var container = document.getElementById('rpe-row-' + dayIndex + '-' + exIndex);
    if (!container) return;
    var ex = workoutData[dayIndex].exercises[exIndex];
    container.innerHTML = renderRpeButton(ex, dayIndex, exIndex);
}

// Открыть модалку
function openRpeModal(dayIndex, exIndex) {
    var ex = workoutData[dayIndex].exercises[exIndex];
    rpeModalCtx = { dayIndex: dayIndex, exIndex: exIndex };
    document.getElementById('rpe-modal-exname').textContent = ex.exercise || '';
    var wf = ex.weightFact || '—';
    var rf = ex.repsFact || '—';
    var sets = ex.sets || '?';
    document.getElementById('rpe-modal-summary').textContent =
        'Ты сделал: ' + wf + ' кг × ' + rf + ' × ' + sets + ' подх.';
    document.getElementById('rpe-modal').classList.remove('hidden');
    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
}

// Закрыть без выбора (трактуется как "норм" при сохранении)
function closeRpeModal() {
    document.getElementById('rpe-modal').classList.add('hidden');
    rpeModalCtx = null;
}

// Выбрать фидбэк → записать в exercise, обновить кнопку, закрыть модалку
function setRpeFeedback(kind) {
    if (!rpeModalCtx || !RPE_FEEDBACK_MAP[kind]) {
        closeRpeModal();
        return;
    }
    var info = RPE_FEEDBACK_MAP[kind];
    var ex = workoutData[rpeModalCtx.dayIndex].exercises[rpeModalCtx.exIndex];
    ex.feedback = kind;
    ex.factualRpe = info.rpe;
    refreshRpeButton(rpeModalCtx.dayIndex, rpeModalCtx.exIndex);
    if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    closeRpeModal();
    // Если "Не вытянул" — попросить уточнить причину (для умной прогрессии)
    if (kind === 'failed') {
        openFailReasonModal(ex);
    }
}

// ─── Под-модалка причины провала ───────────────────────────────────────
var failReasonCtx = null;
function openFailReasonModal(exercise) {
    failReasonCtx = exercise; // запомним прямую ссылку
    document.getElementById('fail-reason-modal').classList.remove('hidden');
}
function closeFailReasonModal() {
    document.getElementById('fail-reason-modal').classList.add('hidden');
    failReasonCtx = null;
}
function setFailReason(reason) {
    if (failReasonCtx) {
        failReasonCtx.failReason = reason;
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    }
    closeFailReasonModal();
}

// Автоматически предложить фидбэк когда упражнение становится completed
function maybeAutoOpenRpe(dayIndex, exIndex) {
    var ex = workoutData[dayIndex].exercises[exIndex];
    if (!ex.completed) return;
    if (ex.feedback) return; // уже оценил
    if (ex._rpeAutoOpenedOnce) return; // не доставать повторно
    ex._rpeAutoOpenedOnce = true;
    // Лёгкая задержка — чтобы клавиатура успела скрыться
    setTimeout(function() { openRpeModal(dayIndex, exIndex); }, 250);
}
 
function handleInput(input) {
    var dayIndex = input.dataset.day;
    var exIndex = input.dataset.exercise;
    var field = input.dataset.field;
    var value = input.value;
    var exercise = workoutData[dayIndex].exercises[exIndex];
    if (field === 'weight') exercise.weightFact = value;
    else if (field === 'reps') exercise.repsFact = value;
    else if (field === 'comment') exercise.comment = value;
    if (value && (field === 'weight' || field === 'reps')) {
        input.classList.add('filled');
        if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    } else {
        input.classList.remove('filled');
    }
    if (field === 'weight' || field === 'reps') {
        var wasCompleted = exercise.completed;
        exercise.completed = !!(exercise.weightFact || exercise.repsFact);
        if (!wasCompleted && exercise.completed) {
            completedCount++;
            updateProgress(true);
        } else if (wasCompleted && !exercise.completed) {
            completedCount--;
            updateProgress(false);
        }
        // Модалка RPE — только когда заполнены ОБЕ ячейки (вес И повторы),
        // чтобы не доставать после первого ввода
        if (exercise.weightFact && exercise.repsFact) {
            maybeAutoOpenRpe(parseInt(dayIndex), parseInt(exIndex));
        }
        // Обновляем счётчик дня в заголовке
        updateDayCounter(parseInt(dayIndex));
    }
}
 
function updateProgress(animate) {
    document.getElementById('completed-count').textContent = completedCount;
    document.getElementById('total-count').textContent = totalExercises;
    var percentage = totalExercises > 0 ? (completedCount / totalExercises) * 100 : 0;
    document.getElementById('progress-fill').style.width = percentage + '%';
    if (animate) {
        var progressInfo = document.querySelector('.progress-info');
        progressInfo.classList.add('pulse');
        setTimeout(function() { progressInfo.classList.remove('pulse'); }, 500);
        if (percentage === 100 && tg.HapticFeedback) {
            tg.HapticFeedback.notificationOccurred('success');
        }
    }
}
 
function updateDayCounter(dayIndex) {
    var day = workoutData[dayIndex];
    if (!day) return;
    var dayCompleted = 0;
    day.exercises.forEach(function(ex) {
        if (ex.weightFact || ex.repsFact) dayCompleted++;
    });
    var dayTotal = day.exercises.length;
    var dayDone = dayCompleted === dayTotal && dayTotal > 0;
    var header = document.querySelector('.day-header[data-day-index="' + dayIndex + '"]');
    if (header) {
        var counter = header.querySelector('.day-counter');
        if (counter) counter.textContent = dayCompleted + '/' + dayTotal;
        // Обновляем галочку
        var status = header.querySelector('.day-status');
        var chevron = header.querySelector('.day-chevron');
        var chevronText = chevron ? chevron.textContent : '▼';
        status.innerHTML = '<span class="day-counter">' + dayCompleted + '/' + dayTotal + '</span>' +
            (dayDone ? ' ✅' : '') +
            '<span class="day-chevron">' + chevronText + '</span>';
    }
}

document.getElementById('save-btn').addEventListener('click', async function() {
    var exercisesToSave = [];
    var btn = document.getElementById('save-btn');
    var originalText = btn.textContent;
    btn.textContent = '⏳ Сохранение...';
    btn.classList.add('saving');
    btn.disabled = true;
    try {
        for (var d = 0; d < workoutData.length; d++) {
            for (var ex = 0; ex < workoutData[d].exercises.length; ex++) {
                var exercise = workoutData[d].exercises[ex];
                if (exercise.weightFact || exercise.repsFact || (exercise.comment && exercise.comment.trim())) {
                    // Если клиент не выставил фидбэк — считаем «норм» (RPE 7.5) по умолчанию
                    var fb = exercise.feedback || 'normal';
                    var fr = exercise.factualRpe || (RPE_FEEDBACK_MAP[fb] && RPE_FEEDBACK_MAP[fb].rpe) || 7.5;
                    exercisesToSave.push({
                        r: exercise.rowIndex,
                        w: exercise.weightFact || '',
                        p: exercise.repsFact || '',
                        c: (exercise.comment && exercise.comment.trim()) ? exercise.comment.trim() : '',
                        e: exercise.exercise,
                        s: exercise.sets,
                        rp: exercise.reps,
                        wp: exercise.weightPlan,
                        rpe: exercise.rpe,           // плановый RPE из шаблона
                        fb: fb,                      // feedback: easy/normal/hard/failed
                        fr: fr,                      // фактический RPE: 5.5/7.5/9/10
                        wn: sessionWellness,         // самочувствие сессии (good/tired/sick/pms)
                        fr2: exercise.failReason || '' // причина провала (sleep/illness/stress/food/too_hard)
                    });
                }
            }
        }
        if (exercisesToSave.length === 0) {
            tg.showAlert('Нечего сохранять! Заполни вес или повторы 📝');
        } else {
            var chatId = tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : '739299264';
            var completionPercent = totalExercises > 0 ? Math.round((completedCount / totalExercises) * 100) : 0;
            var url = APPS_SCRIPT_URL + '?action=write&chatId=' + chatId + '&completionPercent=' + completionPercent;
            var data = null;
            var lastError = '';
            for (var attempt = 0; attempt < 3; attempt++) {
                try {
                    var encoded = encodeURIComponent(JSON.stringify(exercisesToSave));
                    var fullUrl = url + '&exercises=' + encoded;
                    var response;
                    if (fullUrl.length > 7500) {
                        // Split into 2 batches if URL too long
                        var half = Math.ceil(exercisesToSave.length / 2);
                        var batch1 = exercisesToSave.slice(0, half);
                        var batch2 = exercisesToSave.slice(half);
                        var url1 = url + '&exercises=' + encodeURIComponent(JSON.stringify(batch1));
                        var url2 = url + '&exercises=' + encodeURIComponent(JSON.stringify(batch2));
                        response = await fetch(url1);
                        await response.text();
                        response = await fetch(url2);
                    } else {
                        response = await fetch(fullUrl);
                    }
                    var text = await response.text();
                    try {
                        data = JSON.parse(text);
                    } catch (parseErr) {
                        lastError = 'Ответ сервера не JSON: ' + text.substring(0, 100);
                        data = null;
                    }
                    if (data && data.success) break;
                    if (data && data.error) lastError = data.error;
                } catch (err) {
                    lastError = err.message || 'Сетевая ошибка';
                    console.log('Attempt ' + (attempt + 1) + ' failed: ' + lastError);
                    await new Promise(function(r) { setTimeout(r, 2000); });
                }
            }
            if (data && data.success) {
                btn.classList.remove('saving');
                btn.classList.add('success');
                btn.textContent = '✅ Сохранено!';
                if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
                setTimeout(function() {
                    var alertMsg = 'Сохранено ' + exercisesToSave.length + ' упражнений! ✅';
                    if (completionPercent === 100) {
                        alertMsg += '\n\n🎉 Неделя выполнена на 100%! Тренеру придёт уведомление.';
                    }
                    tg.showAlert(alertMsg);
                    btn.classList.remove('success');
                    btn.textContent = originalText;
                }, 1000);
            } else {
                var errMsg = 'Не удалось сохранить ❌\n';
                if (lastError) errMsg += '\nПричина: ' + lastError;
                else if (data && data.error) errMsg += '\nПричина: ' + data.error;
                else errMsg += '\nСервер не ответил. Проверь интернет.';
                tg.showAlert(errMsg);
            }
        }
    } catch (error) {
        console.error('Save error:', error);
        tg.showAlert('Ошибка при сохранении ❌\n\n' + (error.message || 'Неизвестная ошибка'));
    } finally {
        setTimeout(function() {
            btn.classList.remove('saving', 'success');
            btn.textContent = originalText;
            btn.disabled = false;
        }, 1500);
    }
});
 
function openVideo(url) {
    if (!url || url === '📽️') {
        tg.showAlert('Ссылка на видео отсутствует');
        return;
    }
    if (url.indexOf('t.me') !== -1) {
        tg.openTelegramLink(url);
    } else if (url.indexOf('http') !== -1) {
        tg.openLink(url);
    } else {
        tg.showAlert('Неверный формат ссылки');
    }
}
 
var progressChart = null;
var historyData = [];
 
function initializeTabs() {
    document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var tabName = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(function(content) { content.classList.remove('active'); });
            document.getElementById(tabName + '-tab').classList.add('active');
            if (tabName === 'progress') loadProgressData();
            if (tabName === 'measurements') loadMeasurementsData();
            if (tabName === 'admin') { loadAdminClients(); loadDashboardData(); }
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
        });
    });

    // Кнопка "Начать тренировку" на главной — переключает на вкладку Тренировка
    var startBtn = document.getElementById('home-start-btn');
    if (startBtn) {
        startBtn.addEventListener('click', function() {
            var workoutTab = document.querySelector('.tab-btn[data-tab="workout"]');
            if (workoutTab) workoutTab.click();
        });
    }
}

// Главный экран: имя, неделя, кружки прогресса по дням, кнопка
function renderHome() {
    // Приветствие
    var displayName = clientName || (tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.first_name) || '';
    document.getElementById('home-greet').textContent = displayName ? ('Привет, ' + displayName + '!') : 'Привет!';

    // Подзаголовок: процент готовности недели
    var pct = totalExercises > 0 ? Math.round(completedCount / totalExercises * 100) : 0;
    var subtitle;
    if (totalExercises === 0) {
        subtitle = 'На этой неделе тренировок ещё нет';
    } else if (pct === 0) {
        subtitle = 'Готов начать неделю? 💪';
    } else if (pct < 100) {
        subtitle = 'Неделя выполнена на ' + pct + '%';
    } else {
        subtitle = 'Неделя выполнена! 🎉';
    }
    document.getElementById('home-subtitle').textContent = subtitle;

    // Номер недели
    var weekNum = (weekTitle || '').replace(/^Неделя\s+/i, '').trim() || (weekTitle || '—');
    document.getElementById('home-week-num').textContent = weekNum;

    // Кружки по дням: только реальные тренировочные дни (с упражнениями).
    // Строки-разделители (📝 заметки, 🍽️ питание, 📊 план и т.п.) пропускаем.
    var dotsContainer = document.getElementById('home-week-dots');
    dotsContainer.innerHTML = '';
    var trainingDays = workoutData.filter(function(d) {
        return d.exercises && d.exercises.length > 0;
    });
    var doneDays = 0;
    trainingDays.forEach(function(day) {
        var total = day.exercises.length;
        var done = 0;
        day.exercises.forEach(function(ex) {
            if (ex.weightFact || ex.repsFact) done++;
        });
        var dot = document.createElement('div');
        dot.className = 'home-dot';
        if (total > 0 && done >= total) { dot.classList.add('full'); doneDays++; }
        else if (done > 0) dot.classList.add('partial');
        // Метка кружка: первые 2 буквы названия дня без эмодзи и пробелов
        var label = (day.day || '').toString()
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '') // убираем эмодзи
            .trim().substring(0, 2);
        dot.title = day.day + ': ' + done + '/' + total;
        dot.textContent = label || '?';
        dotsContainer.appendChild(dot);
    });

    document.getElementById('home-week-summary').textContent =
        doneDays + ' из ' + trainingDays.length + ' дней выполнено';
}

// Подгружает рекорды и текущий вес для карточек на главной — асинхронно, не блокирует UI
async function loadHomeExtras() {
    var chatId = tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : '739299264';
    try {
        // Последний рекорд
        var histRes = await fetch(APPS_SCRIPT_URL + '?action=history&chatId=' + chatId);
        var histJson = await histRes.json();
        var history = histJson.history || [];
        if (history.length) {
            // Чистим имена и ищем максимум по каждому упражнению
            var bestByEx = {};
            history.forEach(function(d) {
                var name = cleanExerciseName(d.exercise);
                var w = parseFloat(d.weight) || 0;
                if (!bestByEx[name] || w > bestByEx[name].weight) {
                    bestByEx[name] = { weight: w, date: d.date };
                }
            });
            // Самый тяжёлый
            var topName = '', topW = 0, topDate = '';
            for (var k in bestByEx) {
                if (bestByEx[k].weight > topW) {
                    topW = bestByEx[k].weight; topName = k; topDate = bestByEx[k].date;
                }
            }
            if (topW > 0) {
                document.getElementById('home-last-pr').textContent = topW + ' кг';
                document.getElementById('home-last-pr-sub').textContent = topName;
            }
        }
    } catch (e) { console.warn('home extras (history) fail:', e); }

    try {
        // Текущий вес — последний замер
        var measRes = await fetch(APPS_SCRIPT_URL + '?action=getMeasurements&chatId=' + chatId);
        var measJson = await measRes.json();
        var meas = measJson.measurements || [];
        if (meas.length) {
            var last = meas[meas.length - 1];
            if (last.weight) {
                document.getElementById('home-weight').textContent = last.weight + ' кг';
                if (meas.length >= 2) {
                    var prev = meas[meas.length - 2];
                    if (prev.weight) {
                        var diff = (parseFloat(last.weight) - parseFloat(prev.weight));
                        var sign = diff > 0 ? '+' : '';
                        var arrow = diff > 0 ? '📈' : (diff < 0 ? '📉' : '➡️');
                        document.getElementById('home-weight-sub').textContent =
                            arrow + ' ' + sign + diff.toFixed(1) + ' кг с прошлого замера';
                    }
                }
            }
        }
    } catch (e) { console.warn('home extras (meas) fail:', e); }
}
 
async function loadProgressData() {
    try {
        var chatId = tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : '739299264';
        var statsUrl = APPS_SCRIPT_URL + '?action=progress&chatId=' + chatId;
        var statsResponse = await fetch(statsUrl);
        var stats = await statsResponse.json();
        document.getElementById('stat-weeks').textContent = stats.weeksCompleted || 0;
        document.getElementById('stat-exercises').textContent = stats.totalExercises || 0;
        document.getElementById('stat-avg-weight').textContent = (stats.avgWeight || 0) + ' кг';
        await loadExerciseHistory();
    } catch (error) {
        console.error('Progress load error:', error);
    }
}
 
function cleanExerciseName(name) {
    if (!name) return '';
    return name.replace(/^сет:\s*/i, '').replace(/\(сет\)/gi, '').trim();
}

function getMuscleGroup(exerciseName) {
    var name = exerciseName.toLowerCase();
    // Грудь
    if (/жим.*(лёж|леж|горизонт|наклон|гантел.*на\s*(горизонт|наклон))|разводк|кроссовер|сведен.*рук|бабочка|отжим/i.test(name)) return 'Грудь';
    // Спина
    if (/тяг.*(верхн|нижн|горизонт|блок|штанг.*в\s*наклон|гантел.*в\s*наклон)|подтяг|гипер|пуловер|рычаж/i.test(name)) return 'Спина';
    // Ноги
    if (/присед|жим.*платформ|жим.*ног|выпад|разгиб.*ног|сгиб.*ног|икр|голен|гак|станов/i.test(name)) return 'Ноги';
    // Плечи
    if (/жим.*(сид|стоя|арнольд|плеч)|мах|тяг.*подбородк|разводк.*стоя|дельт|протяжк/i.test(name)) return 'Плечи';
    // Бицепс
    if (/бицепс|сгиб.*рук|молот|концентр/i.test(name)) return 'Бицепс';
    // Трицепс
    if (/трицепс|разгиб.*рук|франц|жим.*узк/i.test(name)) return 'Трицепс';
    // Пресс
    if (/пресс|скруч|подъ[её]м.*ног|планк/i.test(name)) return 'Пресс';
    return 'Другое';
}

async function loadExerciseHistory() {
    try {
        var chatId = tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : '739299264';
        var url = APPS_SCRIPT_URL + '?action=history&chatId=' + chatId;
        var response = await fetch(url);
        var data = await response.json();
        if (data.error) {
            console.error('History error:', data.error);
            historyData = [];
            return;
        }
        historyData = data.history || [];
        // Чистим названия от "Сет:"
        historyData.forEach(function(d) {
            d.exercise = cleanExerciseName(d.exercise);
        });

        // Собираем уникальные упражнения
        var exercises = [];
        historyData.forEach(function(d) {
            if (exercises.indexOf(d.exercise) === -1) exercises.push(d.exercise);
        });

        // Группируем по мышцам
        var groups = {};
        var groupOrder = ['Грудь', 'Спина', 'Ноги', 'Плечи', 'Бицепс', 'Трицепс', 'Пресс', 'Другое'];
        exercises.forEach(function(ex) {
            var group = getMuscleGroup(ex);
            if (!groups[group]) groups[group] = [];
            groups[group].push(ex);
        });

        var select = document.getElementById('exercise-select');
        select.innerHTML = '<option value="">Выберите упражнение...</option>';
        groupOrder.forEach(function(groupName) {
            if (!groups[groupName] || groups[groupName].length === 0) return;
            var optgroup = document.createElement('optgroup');
            var groupEmoji = {
                'Грудь': '🫁', 'Спина': '🔙', 'Ноги': '🦵',
                'Плечи': '🤷', 'Бицепс': '💪', 'Трицепс': '💪',
                'Пресс': '🎯', 'Другое': '🏋️'
            };
            optgroup.label = (groupEmoji[groupName] || '') + ' ' + groupName;
            groups[groupName].sort().forEach(function(ex) {
                var option = document.createElement('option');
                option.value = ex;
                option.textContent = ex;
                optgroup.appendChild(option);
            });
            select.appendChild(optgroup);
        });

        select.addEventListener('change', function(e) {
            if (e.target.value) renderChart(e.target.value);
        });
        renderRecords();
    } catch (error) {
        console.error('History load error:', error);
        historyData = [];
    }
}
 
function formatDate(dateStr) {
    if (!dateStr) return '';
    // Если уже в формате dd.MM.yyyy — возвращаем как есть
    if (/^\d{2}\.\d{2}\.\d{4}/.test(dateStr)) return dateStr.substring(0, 10);
    // Если "dd.MM.yyyy HH:mm" — берём только дату
    if (/^\d{2}\.\d{2}\.\d{4}\s/.test(dateStr)) return dateStr.split(' ')[0];
    // Если ISO формат или другой — пробуем распарсить
    try {
        var d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
            var dd = ('0' + d.getDate()).slice(-2);
            var mm = ('0' + (d.getMonth() + 1)).slice(-2);
            return dd + '.' + mm + '.' + d.getFullYear();
        }
    } catch (e) {}
    return String(dateStr);
}

function renderChart(exerciseName) {
    var data = historyData.filter(function(d) { return d.exercise === exerciseName; });
    if (data.length === 0) return;
    if (progressChart) progressChart.destroy();
    var ctx = document.getElementById('progress-chart').getContext('2d');
    progressChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(function(d) { return formatDate(d.date); }),
            datasets: [{
                label: 'Вес (кг)',
                data: data.map(function(d) { return d.weight; }),
                borderColor: '#E53935',
                backgroundColor: 'rgba(229, 57, 53, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 6,
                pointBackgroundColor: '#E53935',
                pointBorderColor: '#fff',
                pointBorderWidth: 2,
                pointHoverRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1a1a1a',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    padding: 12,
                    cornerRadius: 8,
                    displayColors: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: '#f0f0f0' },
                    ticks: { callback: function(value) { return value + ' кг'; } }
                },
                x: { grid: { display: false } }
            }
        }
    });
    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
}
 
function renderRecords() {
    var recordsList = document.getElementById('records-list');
    var records = {};
    historyData.forEach(function(d) {
        if (!records[d.exercise] || d.weight > records[d.exercise].weight) {
            records[d.exercise] = d;
        }
    });
    var top5 = Object.values(records).sort(function(a, b) { return b.weight - a.weight; }).slice(0, 5);
    if (top5.length === 0) {
        recordsList.innerHTML = '<div class="no-data">Пока нет данных о рекордах 📊<br><br>Заполни несколько тренировок!</div>';
        return;
    }
    recordsList.innerHTML = top5.map(function(record, index) {
        var icon = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏆';
        return '<div class="record-item">' +
            '<div class="record-icon">' + icon + '</div>' +
            '<div class="record-name">' + cleanExerciseName(record.exercise) + '</div>' +
            '<div class="record-weight">' + record.weight + ' кг</div>' +
        '</div>';
    }).join('');
}

// ========== СКРЫТИЕ КЛАВИАТУРЫ ==========
// Тап вне input/textarea скрывает клавиатуру
document.addEventListener('click', function(e) {
    var tag = e.target.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
        document.activeElement.blur();
    }
});

// Enter на input — скрывает клавиатуру
document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.target.tagName.toLowerCase() === 'input') {
        e.target.blur();
    }
});

// ========== ADMIN DASHBOARD ==========

var dashboardClients = [];
var currentFilter = 'all';

function initAdminTab() {
    var chatId = tg.initDataUnsafe && tg.initDataUnsafe.user ? String(tg.initDataUnsafe.user.id) : '';
    if (chatId === TRAINER_CHAT_ID) {
        document.getElementById('admin-tab-btn').classList.remove('hidden');
        document.getElementById('tabs-container').classList.add('tabs-5');
        initFilters();
        initAdminClientsControls();
        initClientCardTabs();
        initExerciseEditor();
        initAddTypeDialog();
        initBlockModal();
    }
}

function initFilters() {
    document.querySelectorAll('.filter-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderClientCards();
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
        });
    });
}

async function loadDashboardData() {
    try {
        var url = APPS_SCRIPT_URL + '?action=getFoodDashboard&chatId=' + TRAINER_CHAT_ID;
        var response = await fetch(url);
        var data = await response.json();
        if (data.error) {
            console.error('Dashboard error:', data.error);
            document.getElementById('clients-list').innerHTML = '<div class="no-data">Ошибка загрузки: ' + data.error + '</div>';
            return;
        }
        renderDashboard(data);
    } catch (error) {
        console.error('Dashboard load error:', error);
        document.getElementById('clients-list').innerHTML = '<div class="no-data">Ошибка загрузки данных</div>';
    }
}

function renderDashboard(data) {
    var now = new Date();
    document.getElementById('dashboard-date').textContent = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

    dashboardClients = data.clients || [];
    var alerts = data.alerts || [];
    var stats = data.stats || {};

    document.getElementById('dash-total-clients').textContent = stats.total_clients || dashboardClients.length;
    document.getElementById('dash-need-attention').textContent = alerts.length;

    // Бейдж на вкладке
    var badge = document.getElementById('admin-badge');
    if (alerts.length > 0) {
        badge.textContent = alerts.length;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }

    var totalScore = 0, scoreCount = 0;
    dashboardClients.forEach(function(c) {
        if (c.avgFoodScore && c.avgFoodScore > 0) { totalScore += c.avgFoodScore; scoreCount++; }
    });
    document.getElementById('dash-avg-food-score').textContent = scoreCount > 0 ? (totalScore / scoreCount).toFixed(1) : '-';

    renderClientCards();
}

function renderClientCards() {
    var clientsList = document.getElementById('clients-list');
    var filtered = dashboardClients;

    if (currentFilter === 'problem') {
        filtered = dashboardClients.filter(function(c) { return c.status === 'red' || c.status === 'yellow'; });
    } else if (currentFilter === 'active') {
        filtered = dashboardClients.filter(function(c) { return c.status === 'green'; });
    }

    if (filtered.length === 0) {
        clientsList.innerHTML = '<div class="no-data">Нет клиентов в этой категории</div>';
        return;
    }

    clientsList.innerHTML = filtered.map(function(client) {
        var status = client.status || 'inactive';
        var statusClass, statusIcon;
        if (status === 'green' || status === 'good') { statusClass = 'status-green'; statusIcon = '🟢'; }
        else if (status === 'yellow') { statusClass = 'status-yellow'; statusIcon = '🟡'; }
        else { statusClass = 'status-red'; statusIcon = '🔴'; }

        var workoutPercent = client.workoutPercent != null ? client.workoutPercent + '%' : '-';
        var avgScore = (client.avgFoodScore || 0);
        avgScore = avgScore > 0 ? avgScore.toFixed(1) : '-';

        // Процент калорий
        var calHtml = '';
        if (client.targetCalories > 0) {
            var calPct = client.caloriesPercent || 0;
            var calColor = calPct >= 80 && calPct <= 120 ? '#43A047' : calPct > 120 ? '#E53935' : '#FFA726';
            calHtml = '<div class="client-calories">' +
                '<div class="cal-label">Калории сегодня</div>' +
                '<div class="cal-bar-bg"><div class="cal-bar-fill" style="width:' + Math.min(calPct, 100) + '%;background:' + calColor + '"></div></div>' +
                '<div class="cal-text">' + client.todayCalories + ' / ' + client.targetCalories + ' (' + calPct + '%)</div>' +
            '</div>';
        }

        // Сравнение недель
        var trendHtml = '';
        if (client.weekTrend === 'up') trendHtml = '<span class="week-trend trend-up">📈 Лучше прошлой</span>';
        else if (client.weekTrend === 'down') trendHtml = '<span class="week-trend trend-down">📉 Хуже прошлой</span>';

        // Мини-график веса (sparkline через canvas)
        var sparkHtml = '';
        if (client.avgWeights && client.avgWeights.length >= 2) {
            sparkHtml = '<canvas class="weight-spark" data-weights="' + client.avgWeights.join(',') + '" width="80" height="30"></canvas>';
        }

        // Алерты
        var alertsList = [];
        if (client.missedWorkouts) alertsList.push('Пропускает тренировки');
        if (client.missedFood) alertsList.push('Не записывает питание');
        var alertHtml = alertsList.length > 0 ? '<div class="client-alert">⚠️ ' + alertsList.join(' | ') + '</div>' : '';

        // Кнопка написать
        var msgBtn = client.chatId ? '<button class="msg-client-btn" onclick="messageClient(\'' + client.chatId + '\', \'' + (client.name || '') + '\')">✉️ Написать</button>' : '';

        return '<div class="client-card ' + statusClass + '">' +
            '<div class="client-header">' +
                '<div class="client-status">' + statusIcon + '</div>' +
                '<div class="client-name">' + (client.name || 'Клиент') + '</div>' +
                trendHtml +
                sparkHtml +
            '</div>' +
            '<div class="client-stats">' +
                '<div class="client-stat">' +
                    '<div class="client-stat-label">Тренировки</div>' +
                    '<div class="client-stat-value">' + workoutPercent + '</div>' +
                '</div>' +
                '<div class="client-stat">' +
                    '<div class="client-stat-label">Записей еды</div>' +
                    '<div class="client-stat-value">' + (client.foodCount || 0) + '</div>' +
                '</div>' +
                '<div class="client-stat">' +
                    '<div class="client-stat-label">AI оценка</div>' +
                    '<div class="client-stat-value">' + avgScore + '</div>' +
                '</div>' +
            '</div>' +
            calHtml +
            alertHtml +
            msgBtn +
        '</div>';
    }).join('');

    // Рисуем sparkline-графики
    document.querySelectorAll('.weight-spark').forEach(function(canvas) {
        var weights = canvas.dataset.weights.split(',').map(Number);
        drawSparkline(canvas, weights);
    });
}

function drawSparkline(canvas, data) {
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    var min = Math.min.apply(null, data);
    var max = Math.max.apply(null, data);
    var range = max - min || 1;
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.strokeStyle = '#E53935';
    ctx.lineWidth = 2;
    data.forEach(function(val, i) {
        var x = (i / (data.length - 1)) * w;
        var y = h - ((val - min) / range) * (h - 4) - 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();
}

// ========== ADMIN: КЛИЕНТЫ ПО ТРЕНИРОВКАМ ==========

var adminClients = [];
var adminFilter = 'all';
var adminSort = 'status';
var adminSearch = '';

// Соответствие статуса бэка → иконка + подпись + ранг для сортировки (меньше = выше)
var ADMIN_STATUS_INFO = {
    red:      { icon: '🔴', label: 'Провалы',       rank: 1, klass: 'admin-st-red' },
    orange:   { icon: '🟠', label: 'Пропуск 7+ дн', rank: 2, klass: 'admin-st-orange' },
    yellow:   { icon: '🟡', label: 'Пропустил',    rank: 3, klass: 'admin-st-yellow' },
    green:    { icon: '🟢', label: 'В норме',      rank: 4, klass: 'admin-st-green' },
    inactive: { icon: '⚪', label: 'Неактивный',   rank: 5, klass: 'admin-st-inactive' }
};

function formatDaysAgo(days) {
    if (days == null) return 'не было';
    if (days === 0) return 'сегодня';
    if (days === 1) return 'вчера';
    if (days < 5) return days + ' дн назад';
    if (days < 21) return days + ' дн назад';
    var weeks = Math.floor(days / 7);
    return weeks + ' нед назад';
}

async function loadAdminClients() {
    var list = document.getElementById('admin-clients-list');
    if (list) list.innerHTML = '<div class="no-data">Загрузка клиентов...</div>';
    try {
        var url = APPS_SCRIPT_URL + '?action=getAdminClients';
        var response = await fetch(url);
        var data = await response.json();
        if (data.error) {
            if (list) list.innerHTML = '<div class="no-data">Ошибка: ' + data.error + '</div>';
            return;
        }
        adminClients = data.clients || [];
        renderAdminSummary();
        renderAdminClients();
    } catch (error) {
        console.error('Admin clients load error:', error);
        if (list) list.innerHTML = '<div class="no-data">Ошибка загрузки</div>';
    }
}

function renderAdminSummary() {
    // Архивных в сводку не считаем
    var active = adminClients.filter(function(c) { return c.archived !== true; });
    var archivedCount = adminClients.length - active.length;
    var total = active.length;
    var attention = active.filter(function(c) {
        return c.status === 'red' || c.status === 'orange' || c.status === 'yellow';
    }).length;
    var activeWeek = active.filter(function(c) {
        return c.lastWorkoutDaysAgo != null && c.lastWorkoutDaysAgo < 7;
    }).length;
    document.getElementById('admin-total').textContent = total;
    document.getElementById('admin-attention').textContent = attention;
    document.getElementById('admin-active-week').textContent = activeWeek;
    var archCount = document.getElementById('admin-archive-count');
    if (archCount) archCount.textContent = archivedCount > 0 ? '(' + archivedCount + ')' : '';

    // Бейдж на вкладке
    var badge = document.getElementById('admin-badge');
    if (badge) {
        if (attention > 0) { badge.textContent = attention; badge.classList.remove('hidden'); }
        else badge.classList.add('hidden');
    }

    // Дата
    var dateEl = document.getElementById('dashboard-date');
    if (dateEl) {
        dateEl.textContent = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    }
}

function initAdminClientsControls() {
    // Поиск
    var search = document.getElementById('admin-search');
    if (search) {
        search.addEventListener('input', function() {
            adminSearch = (search.value || '').toLowerCase().trim();
            renderAdminClients();
        });
    }
    // Сортировка
    var sortEl = document.getElementById('admin-sort');
    if (sortEl) {
        sortEl.addEventListener('change', function() {
            adminSort = sortEl.value;
            renderAdminClients();
        });
    }
    // Фильтры
    document.querySelectorAll('.admin-filter-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.admin-filter-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            adminFilter = btn.dataset.adminFilter;
            renderAdminClients();
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
        });
    });
}

function getFilteredAdminClients() {
    var arr = adminClients.slice();
    // Архив — отдельная "папка". Во всех остальных фильтрах архивных скрываем.
    if (adminFilter === 'archive') {
        arr = arr.filter(function(c) { return c.archived === true; });
    } else {
        arr = arr.filter(function(c) { return c.archived !== true; });
        if (adminFilter === 'attention') {
            arr = arr.filter(function(c) { return c.status === 'red' || c.status === 'orange' || c.status === 'yellow'; });
        } else if (adminFilter === 'active') {
            arr = arr.filter(function(c) { return c.status === 'green'; });
        } else if (adminFilter === 'inactive') {
            arr = arr.filter(function(c) { return c.status === 'inactive'; });
        }
    }
    // Поиск
    if (adminSearch) {
        arr = arr.filter(function(c) { return (c.name || '').toLowerCase().indexOf(adminSearch) >= 0; });
    }
    // Сортировка
    if (adminSort === 'status') {
        arr.sort(function(a, b) {
            var ra = (ADMIN_STATUS_INFO[a.status] || {}).rank || 99;
            var rb = (ADMIN_STATUS_INFO[b.status] || {}).rank || 99;
            if (ra !== rb) return ra - rb;
            return (a.name || '').localeCompare(b.name || '', 'ru');
        });
    } else if (adminSort === 'date') {
        arr.sort(function(a, b) {
            var da = a.lastWorkoutDaysAgo == null ? 99999 : a.lastWorkoutDaysAgo;
            var db = b.lastWorkoutDaysAgo == null ? 99999 : b.lastWorkoutDaysAgo;
            return da - db;
        });
    } else if (adminSort === 'alpha') {
        arr.sort(function(a, b) { return (a.name || '').localeCompare(b.name || '', 'ru'); });
    }
    return arr;
}

function renderAdminClients() {
    var list = document.getElementById('admin-clients-list');
    var tbody = document.getElementById('admin-clients-tbody');
    var arr = getFilteredAdminClients();

    if (arr.length === 0) {
        if (list) list.innerHTML = '<div class="no-data">Нет клиентов в этой категории</div>';
        if (tbody) tbody.innerHTML = '';
        return;
    }

    // ── Мобильные карточки ──
    if (list) {
        list.innerHTML = arr.map(function(c) {
            var info = ADMIN_STATUS_INFO[c.status] || ADMIN_STATUS_INFO.inactive;
            var safeName = (c.name || '').replace(/'/g, "\\'");
            var isArchived = c.archived === true;
            var failBadge = (!isArchived && c.failuresLastWorkout >= 2)
                ? '<span class="admin-card-badge admin-badge-red">⚠️ Провалы в последней</span>' : '';
            var archivedBadge = isArchived
                ? '<span class="admin-card-badge admin-badge-archived">📦 В архиве</span>' : '';
            var archiveBtn = isArchived
                ? '<button class="admin-card-btn admin-card-btn-restore" onclick="toggleArchiveClient(\'' + c.chatId + '\', false)">↩️ Вернуть</button>'
                : '<button class="admin-card-btn admin-card-btn-archive" onclick="toggleArchiveClient(\'' + c.chatId + '\', true)">📦 В архив</button>';
            return '<div class="admin-client-card ' + info.klass + (isArchived ? ' admin-card-archived' : '') + '" data-chat="' + (c.chatId || '') + '">' +
                '<div class="admin-card-top">' +
                    '<div class="admin-card-status">' + info.icon + '</div>' +
                    '<div class="admin-card-name">' + (c.name || 'Клиент') + '</div>' +
                    '<div class="admin-card-status-label">' + info.label + '</div>' +
                '</div>' +
                '<div class="admin-card-meta">' +
                    '<div class="admin-card-meta-item">' +
                        '<span class="admin-card-meta-label">📅 Неделя</span>' +
                        '<span class="admin-card-meta-value">' + (c.weekTitle || '—') + '</span>' +
                    '</div>' +
                    '<div class="admin-card-meta-item">' +
                        '<span class="admin-card-meta-label">🏋️ Последняя</span>' +
                        '<span class="admin-card-meta-value">' + formatDaysAgo(c.lastWorkoutDaysAgo) + '</span>' +
                    '</div>' +
                    '<div class="admin-card-meta-item">' +
                        '<span class="admin-card-meta-label">📊 За 7 дней</span>' +
                        '<span class="admin-card-meta-value">' + (c.workouts7Days || 0) + ' трен.</span>' +
                    '</div>' +
                '</div>' +
                archivedBadge +
                failBadge +
                '<div class="admin-card-actions">' +
                    '<button class="admin-card-btn admin-card-btn-primary" onclick="openClientCard(\'' + c.chatId + '\')">👁 Открыть</button>' +
                    '<button class="admin-card-btn" onclick="messageClient(\'' + c.chatId + '\', \'' + safeName + '\')">✉️ Написать</button>' +
                    archiveBtn +
                '</div>' +
            '</div>';
        }).join('');
    }

    // ── Десктоп: таблица ──
    if (tbody) {
        tbody.innerHTML = arr.map(function(c) {
            var info = ADMIN_STATUS_INFO[c.status] || ADMIN_STATUS_INFO.inactive;
            var safeName = (c.name || '').replace(/'/g, "\\'");
            var isArchived = c.archived === true;
            var archiveAction = isArchived
                ? '<button class="admin-row-btn" title="Вернуть из архива" onclick="toggleArchiveClient(\'' + c.chatId + '\', false)">↩️</button>'
                : '<button class="admin-row-btn" title="В архив" onclick="toggleArchiveClient(\'' + c.chatId + '\', true)">📦</button>';
            return '<tr class="' + info.klass + (isArchived ? ' admin-row-archived' : '') + '">' +
                '<td><span class="admin-row-status">' + info.icon + '</span><span class="admin-row-status-label">' + info.label + '</span></td>' +
                '<td class="admin-row-name">' + (c.name || 'Клиент') + (isArchived ? ' <span class="admin-row-archive-tag">📦</span>' : '') + '</td>' +
                '<td>' + (c.weekTitle || '—') + '</td>' +
                '<td>' + formatDaysAgo(c.lastWorkoutDaysAgo) + '</td>' +
                '<td>' + (c.workouts7Days || 0) + '</td>' +
                '<td class="admin-row-actions">' +
                    '<button class="admin-row-btn" title="Открыть" onclick="openClientCard(\'' + c.chatId + '\')">👁</button>' +
                    '<button class="admin-row-btn" title="Написать" onclick="messageClient(\'' + c.chatId + '\', \'' + safeName + '\')">✉️</button>' +
                    archiveAction +
                '</td>' +
            '</tr>';
        }).join('');
    }
}

// ========== АРХИВ КЛИЕНТОВ ==========

async function toggleArchiveClient(chatId, archived) {
    var client = adminClients.find(function(c) { return c.chatId === chatId; });
    var name = client ? client.name : 'клиента';
    var action = archived ? ('Убрать ' + name + ' в архив?') : ('Вернуть ' + name + ' из архива?');
    var confirmed = await new Promise(function(resolve) {
        if (tg && tg.showConfirm) tg.showConfirm(action, function(ok) { resolve(ok); });
        else resolve(confirm(action));
    });
    if (!confirmed) return;

    try {
        var url = APPS_SCRIPT_URL + '?action=setClientArchived&targetChatId=' + encodeURIComponent(chatId) + '&archived=' + (archived ? 'true' : 'false');
        var response = await fetch(url);
        var data = await response.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        // Обновляем локально, чтобы не делать полный re-fetch
        if (client) client.archived = archived;
        renderAdminSummary();
        renderAdminClients();
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    } catch (error) {
        console.error('Archive toggle error:', error);
        tg.showAlert('Ошибка соединения ❌');
    }
}

// ========== КАРТОЧКА КЛИЕНТА (Фаза 2A: просмотр программы) ==========

var currentClientCard = null;

function openClientCard(chatId) {
    var client = adminClients.find(function(c) { return c.chatId === chatId; });
    if (!client) return;
    currentClientCard = client;

    document.getElementById('cc-name').textContent = client.name || 'Клиент';
    document.getElementById('cc-meta').textContent =
        (client.weekTitle || 'Программа') +
        ' · последняя: ' + formatDaysAgo(client.lastWorkoutDaysAgo);

    // Кнопка архива в шапке
    var archBtn = document.getElementById('cc-archive-btn');
    if (archBtn) {
        archBtn.textContent = client.archived ? '↩️' : '📦';
        archBtn.title = client.archived ? 'Вернуть из архива' : 'В архив';
    }

    // Открыть экран
    var screen = document.getElementById('client-card-screen');
    screen.classList.remove('hidden');
    document.body.classList.add('no-scroll');

    // При смене клиента сбрасываем кэш истории
    resetClientHistoryCache();

    // Сбросить на вкладку "Программа"
    switchClientCardTab('program');
    loadClientProgram(client.sheetName);
}

function closeClientCard() {
    var screen = document.getElementById('client-card-screen');
    screen.classList.add('hidden');
    document.body.classList.remove('no-scroll');
    currentClientCard = null;
}

function switchClientCardTab(tabName) {
    document.querySelectorAll('.cc-tab-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.ccTab === tabName);
    });
    document.querySelectorAll('.cc-tab-content').forEach(function(content) {
        content.classList.remove('active');
    });
    document.getElementById('cc-' + tabName + '-tab').classList.add('active');

    // Лениво загружаем содержимое вкладки при первом открытии
    if (tabName === 'history' && currentClientCard) {
        loadClientHistory(currentClientCard.name);
    }
}

function initClientCardTabs() {
    document.querySelectorAll('.cc-tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            switchClientCardTab(btn.dataset.ccTab);
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
        });
    });
}

function toggleArchiveFromCard() {
    if (!currentClientCard) return;
    var newState = !currentClientCard.archived;
    toggleArchiveClient(currentClientCard.chatId, newState).then(function() {
        // После архивирования закрываем карточку (клиент исчез из основного списка)
        if (newState) closeClientCard();
        else {
            // Обновим кнопку
            var archBtn = document.getElementById('cc-archive-btn');
            if (archBtn) {
                archBtn.textContent = currentClientCard.archived ? '↩️' : '📦';
                archBtn.title = currentClientCard.archived ? 'Вернуть из архива' : 'В архив';
            }
        }
    });
}

async function loadClientProgram(sheetName) {
    var container = document.getElementById('cc-program-container');
    container.innerHTML = '<div class="no-data">Загрузка программы...</div>';
    try {
        var url = APPS_SCRIPT_URL + '?action=readClientProgram&sheetName=' + encodeURIComponent(sheetName);
        var response = await fetch(url);
        var data = await response.json();
        if (data.error) {
            container.innerHTML = '<div class="no-data">Ошибка: ' + data.error + '</div>';
            return;
        }
        renderClientProgram(data);
    } catch (error) {
        console.error('Load client program error:', error);
        container.innerHTML = '<div class="no-data">Ошибка загрузки программы</div>';
    }
}

// Префикс «СЕТ:» — суперсет (2 упражнения подряд).
// Префикс «ТРИСЕТ:» — трисет (3 упражнения подряд).
function isSupersetStart(ex) {
    var name = (ex && ex.exercise ? ex.exercise : '').toString().trim();
    return /^сет\s*:/i.test(name);
}

function isTrisetStart(ex) {
    var name = (ex && ex.exercise ? ex.exercise : '').toString().trim();
    return /^трисет\s*:/i.test(name);
}

function cleanExerciseName(name) {
    return (name || '').toString()
        .replace(/^\s*трисет\s*:\s*/i, '')
        .replace(/^\s*сет\s*:\s*/i, '')
        .trim();
}

// Превращает плоский список упражнений в массив групп:
// { type: 'single' | 'superset' | 'triset', exercises: [...], number: <номер для отображения> }
function groupExercises(exercises) {
    var groups = [];
    var displayNum = 0;
    var i = 0;
    while (i < exercises.length) {
        var ex = exercises[i];
        if (isTrisetStart(ex) && i + 2 < exercises.length) {
            displayNum++;
            groups.push({ type: 'triset', exercises: [exercises[i], exercises[i + 1], exercises[i + 2]], number: displayNum });
            i += 3;
        } else if (isSupersetStart(ex) && i + 1 < exercises.length) {
            displayNum++;
            groups.push({ type: 'superset', exercises: [exercises[i], exercises[i + 1]], number: displayNum });
            i += 2;
        } else {
            displayNum++;
            groups.push({ type: 'single', exercises: [ex], number: displayNum });
            i += 1;
        }
    }
    return groups;
}

// Кэш всех упражнений текущей программы (для лёгкого поиска по rowIndex)
var currentProgramExercisesByRow = {};

// Экранируем кавычки для безопасной вставки в onclick=""
function escAttr(s) { return (s == null ? '' : s.toString()).replace(/"/g, '&quot;').replace(/'/g, "\\'"); }

// Рендер одного упражнения внутри блока (без обёртки cc-exercise — для суперсета используется cc-exercise-inner)
function renderExerciseRow(ex, label) {
    var weightPlan = (ex.weightPlan !== '' && ex.weightPlan != null) ? ex.weightPlan : '—';
    var reps = (ex.reps !== '' && ex.reps != null) ? ex.reps : '—';
    var sets = (ex.sets !== '' && ex.sets != null) ? ex.sets : '—';
    var rpe = (ex.rpe !== '' && ex.rpe != null) ? ex.rpe : '—';
    var done = (ex.weightFact !== '' && ex.weightFact != null && ex.weightFact !== 0)
        || (ex.repsFact !== '' && ex.repsFact != null && ex.repsFact !== 0);
    var factHtml = done
        ? '<div class="cc-ex-fact">Факт: ' + (ex.weightFact || '—') + ' кг × ' + (ex.repsFact || '—') + '</div>'
        : '';
    var noteHtml = (ex.note && ex.note.toString().trim())
        ? '<div class="cc-ex-note">' + ex.note + '</div>' : '';
    var labelHtml = label
        ? '<span class="cc-ex-suplabel">' + label + '</span>' : '';
    var editBtn = ex.rowIndex
        ? '<button class="cc-ex-edit-btn" onclick="openExerciseEditor(' + ex.rowIndex + ')" title="Редактировать">✏️</button>'
        : '';
    return '<div class="cc-ex-row">' +
        '<div class="cc-ex-name-row">' +
            '<div class="cc-ex-name">' + labelHtml + cleanExerciseName(ex.exercise) + '</div>' +
            editBtn +
        '</div>' +
        '<div class="cc-ex-grid">' +
            '<div class="cc-ex-cell"><div class="cc-cell-label">Вес</div><div class="cc-cell-value">' + weightPlan + ' кг</div></div>' +
            '<div class="cc-ex-cell"><div class="cc-cell-label">Повт.</div><div class="cc-cell-value">' + reps + '</div></div>' +
            '<div class="cc-ex-cell"><div class="cc-cell-label">Подх.</div><div class="cc-cell-value">' + sets + '</div></div>' +
            '<div class="cc-ex-cell"><div class="cc-cell-label">RPE</div><div class="cc-cell-value">' + rpe + '</div></div>' +
        '</div>' +
        factHtml +
        noteHtml +
    '</div>';
}

// ========== ДЕЙСТВИЯ С ПРОГРАММОЙ КЛИЕНТА (Фаза 2F) ==========

// Дублировать неделю — план остаётся, факты стираются, заголовок инкрементируется
// (автоподбор весов временно отключён, подключим в следующей итерации через ИИ)
async function duplicateWeekFlow() {
    if (!currentClientCard) return;
    var name = currentClientCard.name || 'клиента';

    var confirmed = await new Promise(function(resolve) {
        var msg = 'Создать новую неделю для ' + name + '?\n' +
                  'План упражнений остаётся тем же, факты прошлой недели будут стёрты.';
        if (tg && tg.showConfirm) tg.showConfirm(msg, function(ok) { resolve(ok); });
        else resolve(confirm(msg));
    });
    if (!confirmed) return;

    try {
        var url = APPS_SCRIPT_URL + '?action=duplicateClientWeek' +
            '&sheetName=' + encodeURIComponent(currentClientCard.sheetName) +
            '&autoProgress=false';
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        if (data.newTitle) {
            currentClientCard.weekTitle = data.newTitle;
            document.getElementById('cc-meta').textContent = data.newTitle;
        }
        await loadClientProgram(currentClientCard.sheetName);
        tg.showAlert('✅ Новая неделя создана: ' + (data.newTitle || ''));
    } catch (error) {
        console.error('Duplicate week error:', error);
        tg.showAlert('Ошибка соединения ❌');
    }
}

// Отправить клиенту уведомление о том, что программа обновлена
async function notifyClientFlow() {
    if (!currentClientCard || !currentClientCard.chatId) return;
    var name = currentClientCard.name || 'клиенту';
    var confirmed = await new Promise(function(resolve) {
        var msg = 'Отправить ' + name + ' уведомление о том, что программа обновлена?';
        if (tg && tg.showConfirm) tg.showConfirm(msg, function(ok) { resolve(ok); });
        else resolve(confirm(msg));
    });
    if (!confirmed) return;

    try {
        var url = APPS_SCRIPT_URL + '?action=notifyClient' +
            '&targetChatId=' + encodeURIComponent(currentClientCard.chatId);
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось отправить'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        tg.showAlert('✅ Уведомление отправлено');
    } catch (error) {
        console.error('Notify error:', error);
        tg.showAlert('Ошибка соединения ❌');
    }
}

function renderClientProgram(data) {
    var container = document.getElementById('cc-program-container');
    var days = data.days || [];
    // Заполняем кэш rowIndex → упражнение, чтобы редактор мог быстро взять данные
    currentProgramExercisesByRow = {};
    days.forEach(function(day) {
        (day.exercises || []).forEach(function(ex) {
            if (ex.rowIndex) currentProgramExercisesByRow[ex.rowIndex] = ex;
        });
    });
    if (days.length === 0) {
        container.innerHTML = '<div class="no-data">В программе пока нет упражнений</div>';
        return;
    }

    // Также запоминаем "день" для каждого упражнения (для фильтра библиотеки по группе мышц)
    days.forEach(function(day) {
        (day.exercises || []).forEach(function(ex) {
            if (ex.rowIndex && currentProgramExercisesByRow[ex.rowIndex]) {
                currentProgramExercisesByRow[ex.rowIndex].__dayName = day.day || '';
            }
        });
    });

    container.innerHTML = days.map(function(day, dayIdx) {
        var groups = groupExercises(day.exercises || []);
        var groupsHtml = groups.map(function(group) {
            if (group.type === 'triset') {
                var rowIdxs = group.exercises.map(function(ex) { return ex.rowIndex; }).filter(function(r) { return r; }).join(',');
                return '<div class="cc-exercise cc-superset cc-triset" data-row-indexes="' + rowIdxs + '">' +
                    '<div class="cc-drag-handle">⋮⋮</div>' +
                    '<div class="cc-ex-num">' + group.number + '</div>' +
                    '<div class="cc-ex-info">' +
                        '<div class="cc-superset-header cc-triset-header">Трисет</div>' +
                        '<div class="cc-superset-body">' +
                            renderExerciseRow(group.exercises[0], 'A') +
                            '<div class="cc-superset-divider"></div>' +
                            renderExerciseRow(group.exercises[1], 'B') +
                            '<div class="cc-superset-divider"></div>' +
                            renderExerciseRow(group.exercises[2], 'C') +
                        '</div>' +
                    '</div>' +
                '</div>';
            }
            if (group.type === 'superset') {
                var rowIdxs2 = group.exercises.map(function(ex) { return ex.rowIndex; }).filter(function(r) { return r; }).join(',');
                return '<div class="cc-exercise cc-superset" data-row-indexes="' + rowIdxs2 + '">' +
                    '<div class="cc-drag-handle">⋮⋮</div>' +
                    '<div class="cc-ex-num">' + group.number + '</div>' +
                    '<div class="cc-ex-info">' +
                        '<div class="cc-superset-header">Суперсет</div>' +
                        '<div class="cc-superset-body">' +
                            renderExerciseRow(group.exercises[0], 'A') +
                            '<div class="cc-superset-divider"></div>' +
                            renderExerciseRow(group.exercises[1], 'B') +
                        '</div>' +
                    '</div>' +
                '</div>';
            }
            // single
            var singleRowIdx = group.exercises[0].rowIndex || '';
            return '<div class="cc-exercise" data-row-indexes="' + singleRowIdx + '">' +
                '<div class="cc-drag-handle">⋮⋮</div>' +
                '<div class="cc-ex-num">' + group.number + '</div>' +
                '<div class="cc-ex-info">' +
                    renderExerciseRow(group.exercises[0], '') +
                '</div>' +
            '</div>';
        }).join('');

        var safeDay = (day.day || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        return '<div class="cc-day-block">' +
            '<div class="cc-day-title-row">' +
                '<div class="cc-day-title">' + (day.day || 'Тренировка ' + (dayIdx + 1)) + '</div>' +
                '<button class="cc-day-menu-btn" onclick="showDayActionsDialog(\'' + safeDay + '\')" title="Действия с днём">⋯</button>' +
            '</div>' +
            '<div class="cc-day-exercises" data-day-name="' + safeDay + '">' +
                (groupsHtml || '<div class="no-data">Нет упражнений</div>') +
            '</div>' +
            '<button class="cc-add-ex-btn" onclick="showAddTypeDialog(\'' + safeDay + '\')">+ Добавить упражнение</button>' +
        '</div>';
    }).join('');

    // После списка дней — кнопка «+ Добавить день»
    container.innerHTML += '<button class="cc-add-day-btn" onclick="showAddDayDialog()">+ Добавить день тренировки</button>';

    // Инициализируем drag-and-drop для каждого дня (только внутри одного дня — перенос между днями отключён)
    initDayDragDrop();
}

// ========== ПЕРЕТАСКИВАНИЕ УПРАЖНЕНИЙ (Фаза 2E) ==========

var sortableInstances = [];

function initDayDragDrop() {
    if (typeof Sortable === 'undefined') {
        console.warn('SortableJS not loaded');
        return;
    }
    // Удалим старые инстансы перед перерендером
    sortableInstances.forEach(function(s) { try { s.destroy(); } catch (_) {} });
    sortableInstances = [];

    document.querySelectorAll('.cc-day-exercises').forEach(function(container, dayIdx) {
        var s = Sortable.create(container, {
            group: 'day-' + dayIdx, // разные группы — нельзя перетаскивать между днями
            animation: 180,
            handle: '.cc-drag-handle',
            chosenClass: 'cc-sortable-chosen',
            ghostClass: 'cc-sortable-ghost',
            dragClass: 'cc-sortable-drag',
            forceFallback: true, // надёжнее на iOS
            fallbackTolerance: 5,
            onEnd: function(evt) {
                if (evt.oldIndex === evt.newIndex) return; // ничего не изменилось
                handleDayReorder(container);
            }
        });
        sortableInstances.push(s);
    });
}

async function handleDayReorder(container) {
    if (!currentClientCard) return;

    // Собираем новый порядок rowIndex'ов (для суперсетов — оба row подряд)
    var rowIndexes = [];
    container.querySelectorAll('[data-row-indexes]').forEach(function(el) {
        var ids = (el.dataset.rowIndexes || '').split(',').map(function(s) { return parseInt(s.trim(), 10); }).filter(function(n) { return !isNaN(n); });
        ids.forEach(function(n) { rowIndexes.push(n); });
    });

    if (rowIndexes.length === 0) return;

    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');

    try {
        var url = APPS_SCRIPT_URL + '?action=reorderDayExercises' +
            '&sheetName=' + encodeURIComponent(currentClientCard.sheetName) +
            '&order=' + encodeURIComponent(rowIndexes.join(','));
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Не удалось переставить: ' + (data.error || ''));
            // Восстановим из бэка чтобы UI не врал
            await loadClientProgram(currentClientCard.sheetName);
            return;
        }
        // Перезагрузим — пересчитаются номера и rowIndex'ы
        await loadClientProgram(currentClientCard.sheetName);
    } catch (error) {
        console.error('Reorder error:', error);
        tg.showAlert('Ошибка соединения ❌');
        await loadClientProgram(currentClientCard.sheetName);
    }
}

// ========== ВКЛАДКА «ИСТОРИЯ» (Фаза 3) ==========

// Кэш истории по имени клиента (на случай переключения вкладок туда-сюда)
var clientHistoryCache = {};
var clientHistoryLoadedFor = '';

async function loadClientHistory(clientName) {
    if (!clientName) return;
    var container = document.getElementById('cc-history-container');
    if (!container) return;

    // Если уже грузили для этого клиента — просто перерендерим из кэша
    if (clientHistoryLoadedFor === clientName && clientHistoryCache[clientName]) {
        renderClientHistory(clientHistoryCache[clientName]);
        return;
    }

    container.innerHTML = '<div class="no-data">Загрузка истории...</div>';
    try {
        var url = APPS_SCRIPT_URL + '?action=getClientHistory' +
            '&clientName=' + encodeURIComponent(clientName) +
            '&limit=60';
        var resp = await fetch(url);
        var data = await resp.json();
        if (data.error) {
            container.innerHTML = '<div class="no-data">Ошибка: ' + data.error + '</div>';
            return;
        }
        clientHistoryCache[clientName] = data.history || [];
        clientHistoryLoadedFor = clientName;
        renderClientHistory(data.history || []);
    } catch (error) {
        console.error('Load history error:', error);
        container.innerHTML = '<div class="no-data">Ошибка загрузки истории</div>';
    }
}

// Названия дней недели для даты
var WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
var MONTHS_RU = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

function formatHistoryDate(displayDateStr, dateObj) {
    // displayDateStr — «dd.MM.yyyy»; добавим день недели и месяц словом
    try {
        var d = new Date(dateObj);
        var dayNum = d.getDate();
        var month = MONTHS_RU[d.getMonth()];
        var weekday = WEEKDAYS_RU[d.getDay()];
        return dayNum + ' ' + month + ', ' + weekday;
    } catch (_) { return displayDateStr; }
}

// «Дней назад»
function daysAgoLabel(dateObj) {
    var now = new Date();
    var today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var d = new Date(dateObj);
    var d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var days = Math.round((today0 - d0) / (24 * 60 * 60 * 1000));
    if (days === 0) return 'сегодня';
    if (days === 1) return 'вчера';
    if (days < 7) return days + ' дн назад';
    var weeks = Math.floor(days / 7);
    if (weeks < 5) return weeks + ' нед назад';
    var months = Math.floor(days / 30);
    return months + ' мес назад';
}

function renderClientHistory(history) {
    var container = document.getElementById('cc-history-container');
    if (!container) return;
    if (!history || history.length === 0) {
        container.innerHTML = '<div class="no-data">📅 У клиента пока нет завершённых тренировок</div>';
        return;
    }

    container.innerHTML = history.map(function(day, idx) {
        var dateLabel = formatHistoryDate(day.date, day.dateObj);
        var agoLabel = daysAgoLabel(day.dateObj);
        var isOpen = idx === 0; // самая свежая открыта по умолчанию

        // Группа по неделям/дням внутри одной даты — берём первую неделю и название дня (если есть)
        var weekInfo = '';
        if (day.exercises && day.exercises.length) {
            var firstEx = day.exercises[0];
            var parts = [];
            if (firstEx.week) parts.push(firstEx.week);
            if (firstEx.day) parts.push(firstEx.day);
            if (parts.length) weekInfo = '<div class="hh-week">' + parts.join(' · ') + '</div>';
        }

        // Рендер упражнений
        var exHtml = (day.exercises || []).map(function(ex) {
            var fact = '';
            if (ex.weightFact !== '' && ex.weightFact != null) {
                fact = ex.weightFact + ' кг';
                if (ex.repsFact !== '' && ex.repsFact != null) fact += ' × ' + ex.repsFact;
            }
            var rpe = (ex.rpe !== '' && ex.rpe != null) ? ' · RPE ' + ex.rpe : '';
            var commentHtml = (ex.comment && ex.comment.toString().trim())
                ? '<div class="hh-ex-comment">💬 ' + ex.comment + '</div>' : '';
            var planText = '';
            if (ex.weightPlan) {
                planText = '<span class="hh-ex-plan">план: ' + ex.weightPlan + ' × ' + (ex.reps || '—') + '</span>';
            }
            return '<div class="hh-ex">' +
                '<div class="hh-ex-name">' + cleanExerciseName(ex.exercise) + '</div>' +
                '<div class="hh-ex-fact">' +
                    (fact ? '<span class="hh-ex-fact-value">' + fact + '</span>' : '<span class="hh-ex-skipped">не выполнено</span>') +
                    rpe +
                '</div>' +
                planText +
                commentHtml +
            '</div>';
        }).join('');

        return '<details class="hh-day"' + (isOpen ? ' open' : '') + '>' +
            '<summary class="hh-day-summary">' +
                '<div class="hh-day-head">' +
                    '<div class="hh-date">📅 ' + dateLabel + '</div>' +
                    '<div class="hh-ago">' + agoLabel + '</div>' +
                '</div>' +
                weekInfo +
                '<div class="hh-count">' + day.exercises.length + ' упр.</div>' +
            '</summary>' +
            '<div class="hh-day-body">' + exHtml + '</div>' +
        '</details>';
    }).join('');
}

// При смене клиента — сбрасываем кэш истории
function resetClientHistoryCache() {
    clientHistoryLoadedFor = '';
}

// ========== РЕДАКТОР УПРАЖНЕНИЯ (Фаза 2B + 2C) ==========

var currentEditingRow = null;
var currentEditingMode = 'edit'; // 'edit' | 'add'
var currentAddDay = '';          // используется в режиме 'add'
var currentSetType = 'single';   // 'single' | 'superset' | 'triset' (только в режиме add)
var activeNameInputId = 'ex-edit-name'; // какое поле «Название» сейчас активно для библиотеки

function openExerciseEditor(rowIndex) {
    var ex = currentProgramExercisesByRow[rowIndex];
    if (!ex || !currentClientCard) return;
    currentEditingRow = rowIndex;
    currentEditingMode = 'edit';
    currentAddDay = '';
    currentSetType = 'single';

    // Скрываем переключатель типа и блоки B/C при редактировании одного упражнения
    document.getElementById('ex-type-switch').classList.add('hidden');
    document.getElementById('ex-block-B').classList.add('hidden');
    document.getElementById('ex-block-C').classList.add('hidden');
    document.getElementById('ex-block-A-title').classList.add('hidden');

    document.getElementById('ex-editor-title').textContent = cleanExerciseName(ex.exercise) || 'Упражнение';
    document.getElementById('ex-edit-name').value = cleanExerciseName(ex.exercise) || '';
    document.getElementById('ex-edit-weight').value = ex.weightPlan != null ? ex.weightPlan : '';
    document.getElementById('ex-edit-reps').value = ex.reps != null ? ex.reps : '';
    document.getElementById('ex-edit-sets').value = ex.sets != null ? ex.sets : '';
    document.getElementById('ex-edit-rpe').value = ex.rpe != null ? ex.rpe : '';
    document.getElementById('ex-edit-note').value = ex.note != null ? ex.note : '';

    // Кнопка «Удалить» — только в режиме редактирования
    var delBtn = document.getElementById('ex-edit-delete-btn');
    if (delBtn) delBtn.classList.remove('hidden');
    var saveBtn = document.getElementById('ex-edit-save-btn');
    if (saveBtn) saveBtn.textContent = '💾 Сохранить';

    // Подсказка про последний факт
    var hint = document.getElementById('ex-edit-history-hint');
    var done = (ex.weightFact !== '' && ex.weightFact != null && ex.weightFact !== 0)
        || (ex.repsFact !== '' && ex.repsFact != null && ex.repsFact !== 0);
    if (done) {
        hint.textContent = 'Последний факт клиента: ' + (ex.weightFact || '—') + ' кг × ' + (ex.repsFact || '—');
        hint.classList.remove('hidden');
    } else {
        hint.textContent = '';
        hint.classList.add('hidden');
    }

    document.getElementById('ex-editor-modal').classList.remove('hidden');

    // Готовим библиотеку и сбрасываем фильтр на "Этот день"
    libraryFilterMuscle = 'day';
    librarySearchText = '';
    closeExerciseLibrary();
    loadExerciseLibrary(); // фоном — потом откроется быстро по фокусу
}

// Открыть модалку для ДОБАВЛЕНИЯ нового упражнения / суперсета / трисета в указанный день
function openAddExerciseModal(dayName) {
    if (!currentClientCard) return;
    currentEditingRow = null;
    currentEditingMode = 'add';
    currentAddDay = dayName || '';
    currentSetType = 'single';

    document.getElementById('ex-editor-title').textContent = '+ Новое упражнение' + (dayName ? ' · ' + dayName : '');

    // Скрываем переключатель типа и блоки B/C — для одиночного режима они не нужны
    // (для суперсета/трисета используется отдельная модалка #ex-block-modal через showAddTypeDialog)
    var typeSwitch = document.getElementById('ex-type-switch'); if (typeSwitch) typeSwitch.classList.add('hidden');
    var bB = document.getElementById('ex-block-B'); if (bB) bB.classList.add('hidden');
    var bC = document.getElementById('ex-block-C'); if (bC) bC.classList.add('hidden');
    var tA = document.getElementById('ex-block-A-title'); if (tA) tA.classList.add('hidden');
    currentSetType = 'single';

    // Очищаем поля (блок A — единственный в одиночном режиме)
    document.getElementById('ex-edit-name').value = '';
    document.getElementById('ex-edit-weight').value = '';
    document.getElementById('ex-edit-reps').value = '';
    document.getElementById('ex-edit-sets').value = '4';
    document.getElementById('ex-edit-rpe').value = '8';
    document.getElementById('ex-edit-note').value = '';

    // Скрываем кнопку «Удалить» и подсказку фактов
    var delBtn = document.getElementById('ex-edit-delete-btn');
    if (delBtn) delBtn.classList.add('hidden');
    var saveBtn = document.getElementById('ex-edit-save-btn');
    if (saveBtn) saveBtn.textContent = '➕ Добавить';
    var hint = document.getElementById('ex-edit-history-hint');
    hint.textContent = '';
    hint.classList.add('hidden');

    document.getElementById('ex-editor-modal').classList.remove('hidden');

    // Готовим библиотеку
    libraryFilterMuscle = 'day';
    librarySearchText = '';
    activeNameInputId = 'ex-edit-name';
    closeExerciseLibrary();
    loadExerciseLibrary();
    setTimeout(function() {
        var nameInput = document.getElementById('ex-edit-name');
        if (nameInput) nameInput.focus();
    }, 200);
}

// Переключение типа набора: single / superset / triset
function setSetType(type) {
    currentSetType = type;
    var blockB = document.getElementById('ex-block-B');
    var blockC = document.getElementById('ex-block-C');
    var titleA = document.getElementById('ex-block-A-title');

    if (type === 'single') {
        blockB.classList.add('hidden');
        blockC.classList.add('hidden');
        titleA.classList.add('hidden');
    } else if (type === 'superset') {
        blockB.classList.remove('hidden');
        blockC.classList.add('hidden');
        titleA.classList.remove('hidden');
    } else if (type === 'triset') {
        blockB.classList.remove('hidden');
        blockC.classList.remove('hidden');
        titleA.classList.remove('hidden');
    }

    // Обновим визуально активную кнопку переключателя
    document.querySelectorAll('.ex-type-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.setType === type);
    });

    // Закроем библиотеку если была открыта (контекст полей сменился)
    closeExerciseLibrary();
}

function initSetTypeSwitch() {
    document.querySelectorAll('.ex-type-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            setSetType(btn.dataset.setType);
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
        });
    });
}

function closeExerciseEditor() {
    document.getElementById('ex-editor-modal').classList.add('hidden');
    closeExerciseLibrary();
    currentEditingRow = null;
}

async function saveExerciseEdit() {
    if (!currentClientCard) return;
    var saveBtn = document.getElementById('ex-edit-save-btn');
    var origText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳ Сохранение...';

    var nameVal = document.getElementById('ex-edit-name').value.trim();
    if (!nameVal) {
        tg.showAlert('Укажи название упражнения');
        saveBtn.disabled = false;
        saveBtn.textContent = origText;
        return;
    }

    var params;
    if (currentEditingMode === 'add') {
        params = {
            action: 'addClientExercise',
            sheetName: currentClientCard.sheetName,
            dayName: currentAddDay,
            exercise: nameVal,
            weightPlan: document.getElementById('ex-edit-weight').value.trim(),
            reps: document.getElementById('ex-edit-reps').value.trim(),
            sets: document.getElementById('ex-edit-sets').value.trim(),
            rpe: document.getElementById('ex-edit-rpe').value.trim(),
            note: document.getElementById('ex-edit-note').value.trim()
        };
    } else {
        if (!currentEditingRow) {
            saveBtn.disabled = false;
            saveBtn.textContent = origText;
            return;
        }
        params = {
            action: 'updateClientExercise',
            sheetName: currentClientCard.sheetName,
            rowIndex: currentEditingRow,
            exercise: nameVal,
            weightPlan: document.getElementById('ex-edit-weight').value.trim(),
            reps: document.getElementById('ex-edit-reps').value.trim(),
            sets: document.getElementById('ex-edit-sets').value.trim(),
            rpe: document.getElementById('ex-edit-rpe').value.trim(),
            note: document.getElementById('ex-edit-note').value.trim()
        };
    }

    try {
        var query = Object.keys(params).map(function(k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
        }).join('&');
        var response = await fetch(APPS_SCRIPT_URL + '?' + query);
        var data = await response.json();
        if (!data.success) {
            tg.showAlert('Ошибка сохранения: ' + (data.error || 'не удалось'));
            saveBtn.disabled = false;
            saveBtn.textContent = origText;
            return;
        }
        saveBtn.textContent = currentEditingMode === 'add' ? '✅ Добавлено' : '✅ Сохранено';
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        await loadClientProgram(currentClientCard.sheetName);
        setTimeout(function() {
            closeExerciseEditor();
            saveBtn.disabled = false;
            saveBtn.textContent = origText;
        }, 400);
    } catch (error) {
        console.error('Save exercise error:', error);
        tg.showAlert('Ошибка соединения ❌');
        saveBtn.disabled = false;
        saveBtn.textContent = origText;
    }
}

async function deleteExerciseEdit() {
    if (!currentEditingRow || !currentClientCard) return;
    var ex = currentProgramExercisesByRow[currentEditingRow];
    var name = ex ? cleanExerciseName(ex.exercise) : 'упражнение';
    var confirmed = await new Promise(function(resolve) {
        if (tg && tg.showConfirm) tg.showConfirm('Удалить «' + name + '» из программы?', function(ok) { resolve(ok); });
        else resolve(confirm('Удалить «' + name + '» из программы?'));
    });
    if (!confirmed) return;

    var delBtn = document.getElementById('ex-edit-delete-btn');
    var origText = delBtn.textContent;
    delBtn.disabled = true;
    delBtn.textContent = '⏳ Удаление...';
    try {
        var url = APPS_SCRIPT_URL + '?action=deleteClientExercise' +
            '&sheetName=' + encodeURIComponent(currentClientCard.sheetName) +
            '&rowIndex=' + currentEditingRow;
        var response = await fetch(url);
        var data = await response.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            delBtn.disabled = false;
            delBtn.textContent = origText;
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        await loadClientProgram(currentClientCard.sheetName);
        closeExerciseEditor();
        delBtn.disabled = false;
        delBtn.textContent = origText;
    } catch (error) {
        console.error('Delete exercise error:', error);
        tg.showAlert('Ошибка соединения ❌');
        delBtn.disabled = false;
        delBtn.textContent = origText;
    }
}

function initExerciseEditor() {
    var saveBtn = document.getElementById('ex-edit-save-btn');
    var delBtn = document.getElementById('ex-edit-delete-btn');
    if (saveBtn) saveBtn.addEventListener('click', saveExerciseEdit);
    if (delBtn) delBtn.addEventListener('click', deleteExerciseEdit);

    initSetTypeSwitch();

    // Поля «Название» (A, B, C): фокус → открыть библиотеку, ввод → фильтр
    document.querySelectorAll('.ex-name-field').forEach(function(input) {
        input.addEventListener('focus', function() {
            activeNameInputId = input.id;
            openExerciseLibrary();
        });
        input.addEventListener('input', function() {
            // Активным считается тот, в кого вводят
            activeNameInputId = input.id;
            librarySearchText = (input.value || '').toLowerCase().trim();
            renderLibraryList();
        });
    });
}

// ========== БИБЛИОТЕКА УПРАЖНЕНИЙ (Фаза 2B+) ==========

var exerciseLibrary = [];
var exerciseLibraryLoaded = false;
var libraryFilterMuscle = 'day';  // 'day' | 'all' | <название мышцы>
var librarySearchText = '';

// Известные группы мышц (в нижнем регистре) для парсинга имён дней.
// Соответствует значениям колонки E листа «Упражнения».
var KNOWN_MUSCLES = ['грудь', 'спина', 'плечи', 'бицепс', 'трицепс', 'ноги', 'ягодицы', 'пресс', 'икры', 'предплечья'];

// Проверяет, относится ли упражнение к указанной мышце.
// Только по полю group из листа «Упражнения» — никаких эвристик по названию.
function exerciseHitsMuscle(ex, muscle) {
    var g = (ex.group || '').toLowerCase().trim();
    if (!g) return false;
    return g.indexOf(muscle) >= 0;
}

async function loadExerciseLibrary() {
    if (exerciseLibraryLoaded) return;
    try {
        var url = APPS_SCRIPT_URL + '?action=getExerciseLibrary';
        var resp = await fetch(url);
        var data = await resp.json();
        if (data && !data.error) {
            exerciseLibrary = data.exercises || [];
            exerciseLibraryLoaded = true;
        }
    } catch (e) {
        console.error('Library load error:', e);
    }
}

// Достаёт мышцы из названия дня тренировки (например "Пн Спина-Грудь-Плечи")
function getMusclesFromDay(dayName) {
    var name = (dayName || '').toLowerCase();
    return KNOWN_MUSCLES.filter(function(m) { return name.indexOf(m) >= 0; });
}

// Совпадает ли упражнение с заданным набором групп мышц (хотя бы одной)
function exerciseMatchesMuscles(ex, muscles) {
    if (!muscles || muscles.length === 0) return true;
    return muscles.some(function(m) { return exerciseHitsMuscle(ex, m); });
}

async function openExerciseLibrary() {
    var panel = document.getElementById('ex-library-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    librarySearchText = '';

    // Показываем для какого блока сейчас выбираем (только если виден переключатель — режим add с супер/трисетом)
    var ctx = document.getElementById('ex-library-context');
    if (ctx) {
        if (currentSetType !== 'single') {
            var activeInput = document.getElementById(activeNameInputId);
            var blockLabel = activeInput ? activeInput.dataset.block : '';
            var label = blockLabel === 'A' ? 'А — первое' : (blockLabel === 'B' ? 'Б — второе' : 'В — третье');
            ctx.textContent = 'Выбираешь для: ' + label;
            ctx.classList.remove('hidden');
        } else {
            ctx.classList.add('hidden');
        }
    }

    if (!exerciseLibraryLoaded) {
        document.getElementById('ex-library-list').innerHTML = '<div class="ex-library-loading">Загрузка библиотеки...</div>';
        await loadExerciseLibrary();
    }
    renderLibraryTabs();
    renderLibraryList();
}

function closeExerciseLibrary() {
    var panel = document.getElementById('ex-library-panel');
    if (panel) panel.classList.add('hidden');
}

// Текущий «день» для фильтра библиотеки — берём из редактируемого упражнения или из режима добавления.
function getCurrentDayForLibrary() {
    if (currentEditingMode === 'add') return currentAddDay || '';
    var ex = currentEditingRow ? currentProgramExercisesByRow[currentEditingRow] : null;
    return ex ? (ex.__dayName || '') : '';
}

function renderLibraryTabs() {
    var tabsEl = document.getElementById('ex-library-tabs');
    if (!tabsEl) return;
    var dayName = getCurrentDayForLibrary();
    var muscles = getMusclesFromDay(dayName);

    var tabs = [];
    if (muscles.length > 0) {
        tabs.push({ key: 'day', label: 'Этот день' });
    } else {
        // Если в названии дня не нашли мышц — фолбэк на "Все" по умолчанию
        libraryFilterMuscle = 'all';
    }
    tabs.push({ key: 'all', label: 'Все' });
    muscles.forEach(function(m) {
        tabs.push({ key: m, label: m.charAt(0).toUpperCase() + m.slice(1) });
    });

    tabsEl.innerHTML = tabs.map(function(t) {
        var active = t.key === libraryFilterMuscle ? ' active' : '';
        return '<button type="button" class="ex-lib-tab' + active + '" data-muscle="' + t.key + '">' + t.label + '</button>';
    }).join('');

    tabsEl.querySelectorAll('.ex-lib-tab').forEach(function(btn) {
        btn.addEventListener('click', function() {
            tabsEl.querySelectorAll('.ex-lib-tab').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            libraryFilterMuscle = btn.dataset.muscle;
            renderLibraryList();
        });
    });
}

function renderLibraryList() {
    var listEl = document.getElementById('ex-library-list');
    if (!listEl) return;
    var dayName = getCurrentDayForLibrary();
    var dayMuscles = getMusclesFromDay(dayName);

    var filtered = exerciseLibrary.filter(function(item) {
        // По мышцам
        if (libraryFilterMuscle === 'all') { /* без фильтра */ }
        else if (libraryFilterMuscle === 'day') {
            if (!exerciseMatchesMuscles(item, dayMuscles)) return false;
        } else {
            if (!exerciseMatchesMuscles(item, [libraryFilterMuscle])) return false;
        }
        // По строке поиска
        if (librarySearchText && item.name.toLowerCase().indexOf(librarySearchText) < 0) return false;
        return true;
    });

    if (filtered.length === 0) {
        listEl.innerHTML = '<div class="ex-library-empty">Ничего не найдено</div>';
        return;
    }

    listEl.innerHTML = filtered.slice(0, 80).map(function(item) {
        var safe = (item.name || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        var groupHtml = item.group ? '<div class="ex-lib-item-group">' + item.group + '</div>' : '';
        return '<button type="button" class="ex-lib-item" onclick="selectExerciseFromLibrary(\'' + safe + '\')">' +
            '<div class="ex-lib-item-name">' + item.name + '</div>' +
            groupHtml +
        '</button>';
    }).join('');
}

function selectExerciseFromLibrary(name) {
    var input = document.getElementById(activeNameInputId) || document.getElementById('ex-edit-name');
    if (input) input.value = name;
    closeExerciseLibrary();
    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
}

// ========== ДОБАВЛЕНИЕ БЛОКА (суперсет / трисет) ==========

var currentBlockType = 'superset';
var currentBlockDay = '';

// Кастомный диалог выбора типа добавления — стилизованный, единообразный на всех платформах
var pendingAddDay = '';

function showAddTypeDialog(dayName) {
    if (!currentClientCard) return;
    pendingAddDay = dayName || '';
    var subtitle = document.getElementById('ex-add-type-subtitle');
    if (subtitle) subtitle.textContent = dayName ? ('в день: ' + dayName) : '';
    document.getElementById('ex-add-type-modal').classList.remove('hidden');
}

function closeAddTypeDialog() {
    document.getElementById('ex-add-type-modal').classList.add('hidden');
}

function initAddTypeDialog() {
    document.querySelectorAll('.ex-add-type-option').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var type = btn.dataset.type;
            closeAddTypeDialog();
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
            if (type === 'single')        openAddExerciseModal(pendingAddDay);
            else if (type === 'superset') openBlockModal(pendingAddDay, 'superset');
            else if (type === 'triset')   openBlockModal(pendingAddDay, 'triset');
        });
    });
}

// ========== УПРАВЛЕНИЕ ДНЯМИ ТРЕНИРОВКИ (Фаза C) ==========

// Диалог действий с днём — переименовать или удалить
function showDayActionsDialog(dayName) {
    if (!currentClientCard || !dayName) return;
    document.getElementById('day-actions-name').textContent = dayName;
    document.getElementById('day-actions-modal').dataset.dayName = dayName;
    document.getElementById('day-actions-modal').classList.remove('hidden');
}

function closeDayActionsDialog() {
    document.getElementById('day-actions-modal').classList.add('hidden');
}

async function renameCurrentDay() {
    var modal = document.getElementById('day-actions-modal');
    var oldName = modal.dataset.dayName;
    closeDayActionsDialog();
    if (!oldName || !currentClientCard) return;

    var newName = await new Promise(function(resolve) {
        if (tg && typeof tg.showPopup === 'function' && false) {
            // showPopup не умеет принимать ввод текста — используем JS prompt
        }
        resolve(prompt('Новое название дня:', oldName));
    });
    if (!newName || newName.trim() === '' || newName.trim() === oldName) return;

    try {
        var url = APPS_SCRIPT_URL + '?action=renameClientDay' +
            '&sheetName=' + encodeURIComponent(currentClientCard.sheetName) +
            '&oldDayName=' + encodeURIComponent(oldName) +
            '&newDayName=' + encodeURIComponent(newName.trim());
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        await loadClientProgram(currentClientCard.sheetName);
    } catch (error) {
        console.error('Rename day error:', error);
        tg.showAlert('Ошибка соединения ❌');
    }
}

async function deleteCurrentDay() {
    var modal = document.getElementById('day-actions-modal');
    var dayName = modal.dataset.dayName;
    closeDayActionsDialog();
    if (!dayName || !currentClientCard) return;

    var confirmed = await new Promise(function(resolve) {
        var msg = 'Удалить день «' + dayName + '» вместе со всеми упражнениями внутри?';
        if (tg && tg.showConfirm) tg.showConfirm(msg, function(ok) { resolve(ok); });
        else resolve(confirm(msg));
    });
    if (!confirmed) return;

    try {
        var url = APPS_SCRIPT_URL + '?action=deleteClientDay' +
            '&sheetName=' + encodeURIComponent(currentClientCard.sheetName) +
            '&dayName=' + encodeURIComponent(dayName);
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        await loadClientProgram(currentClientCard.sheetName);
    } catch (error) {
        console.error('Delete day error:', error);
        tg.showAlert('Ошибка соединения ❌');
    }
}

async function showAddDayDialog() {
    if (!currentClientCard) return;
    var dayName = prompt('Название нового дня (например: «Пт Грудь-Трицепс»):');
    if (!dayName || !dayName.trim()) return;
    try {
        var url = APPS_SCRIPT_URL + '?action=addClientDay' +
            '&sheetName=' + encodeURIComponent(currentClientCard.sheetName) +
            '&dayName=' + encodeURIComponent(dayName.trim());
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        await loadClientProgram(currentClientCard.sheetName);
    } catch (error) {
        console.error('Add day error:', error);
        tg.showAlert('Ошибка соединения ❌');
    }
}

function openBlockModal(dayName, type) {
    currentBlockType = type;
    currentBlockDay = dayName || '';
    var count = type === 'triset' ? 3 : 2;
    var title = type === 'triset' ? '+ Новый трисет (3 упр.)' : '+ Новый суперсет (2 упр.)';
    document.getElementById('ex-block-title').textContent = title + (dayName ? ' · ' + dayName : '');

    // Рендерим N секций
    var html = '';
    for (var i = 0; i < count; i++) {
        var label = String.fromCharCode(65 + i); // A, B, C
        html +=
            '<div class="ex-block-section" data-block-idx="' + i + '">' +
                '<div class="ex-block-section-title">' + label + ' — упражнение ' + (i + 1) + '</div>' +
                '<div class="ex-editor-field">' +
                    '<label class="ex-editor-label">Название</label>' +
                    '<input type="text" class="ex-editor-input ex-block-name" data-idx="' + i + '" placeholder="Например: Жим штанги лёжа">' +
                '</div>' +
                '<div class="ex-editor-row">' +
                    '<div class="ex-editor-field">' +
                        '<label class="ex-editor-label">Вес</label>' +
                        '<input type="text" class="ex-editor-input ex-block-weight" data-idx="' + i + '" placeholder="60 или 60-70">' +
                    '</div>' +
                    '<div class="ex-editor-field">' +
                        '<label class="ex-editor-label">Повторы</label>' +
                        '<input type="text" class="ex-editor-input ex-block-reps" data-idx="' + i + '" placeholder="8 или 8-10">' +
                    '</div>' +
                '</div>' +
                '<div class="ex-editor-row">' +
                    '<div class="ex-editor-field">' +
                        '<label class="ex-editor-label">Подходы</label>' +
                        '<input type="number" inputmode="numeric" class="ex-editor-input ex-block-sets" data-idx="' + i + '" placeholder="4" value="4">' +
                    '</div>' +
                    '<div class="ex-editor-field">' +
                        '<label class="ex-editor-label">Target RPE</label>' +
                        '<input type="number" inputmode="decimal" step="0.5" min="1" max="10" class="ex-editor-input ex-block-rpe" data-idx="' + i + '" placeholder="8" value="8">' +
                    '</div>' +
                '</div>' +
                '<div class="ex-editor-field">' +
                    '<label class="ex-editor-label">Заметка тренера</label>' +
                    '<textarea class="ex-editor-textarea ex-block-note" data-idx="' + i + '" rows="1" placeholder="(опционально)"></textarea>' +
                '</div>' +
            '</div>';
    }
    document.getElementById('ex-block-body').innerHTML = html;
    document.getElementById('ex-block-modal').classList.remove('hidden');
}

function closeBlockModal() {
    document.getElementById('ex-block-modal').classList.add('hidden');
}

async function saveBlock() {
    if (!currentClientCard) return;
    var saveBtn = document.getElementById('ex-block-save-btn');
    var origText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳ Добавление...';

    // Собираем все секции
    var sections = document.querySelectorAll('#ex-block-body .ex-block-section');
    var exercises = [];
    for (var i = 0; i < sections.length; i++) {
        var s = sections[i];
        var name = s.querySelector('.ex-block-name').value.trim();
        if (!name) {
            tg.showAlert('Заполни название упражнения ' + String.fromCharCode(65 + i));
            saveBtn.disabled = false;
            saveBtn.textContent = origText;
            return;
        }
        // Префикс «СЕТ:» / «ТРИСЕТ:» только у первого
        if (i === 0) {
            var prefix = currentBlockType === 'triset' ? 'ТРИСЕТ: ' : 'СЕТ: ';
            name = prefix + name;
        }
        exercises.push({
            exercise: name,
            weightPlan: s.querySelector('.ex-block-weight').value.trim(),
            reps: s.querySelector('.ex-block-reps').value.trim(),
            sets: s.querySelector('.ex-block-sets').value.trim(),
            rpe: s.querySelector('.ex-block-rpe').value.trim(),
            note: s.querySelector('.ex-block-note').value.trim()
        });
    }

    try {
        var url = APPS_SCRIPT_URL +
            '?action=addClientExercises&sheetName=' + encodeURIComponent(currentClientCard.sheetName) +
            '&dayName=' + encodeURIComponent(currentBlockDay);
        var resp = await fetch(url, {
            method: 'POST',
            body: JSON.stringify({ exercises: exercises })
        });
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            saveBtn.disabled = false;
            saveBtn.textContent = origText;
            return;
        }
        saveBtn.textContent = '✅ Добавлено';
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        await loadClientProgram(currentClientCard.sheetName);
        setTimeout(function() {
            closeBlockModal();
            saveBtn.disabled = false;
            saveBtn.textContent = origText;
        }, 400);
    } catch (error) {
        console.error('Save block error:', error);
        tg.showAlert('Ошибка соединения ❌');
        saveBtn.disabled = false;
        saveBtn.textContent = origText;
    }
}

function initBlockModal() {
    var saveBtn = document.getElementById('ex-block-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', saveBlock);
}

// ========== MEASUREMENTS TAB ==========

var measurementsData = [];
var measurementsChart = null;
var measSelectInitialized = false;

var MEAS_LABELS = {
    weight: 'Вес', shoulders: 'Плечи', chest: 'Грудь', waist: 'Талия',
    hips: 'Бёдра', bicep: 'Бицепс', thigh: 'Бедро'
};
var MEAS_UNITS = {
    weight: 'кг', shoulders: 'см', chest: 'см', waist: 'см',
    hips: 'см', bicep: 'см', thigh: 'см'
};

async function loadMeasurementsData() {
    try {
        var chatId = tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : '739299264';
        var url = APPS_SCRIPT_URL + '?action=getMeasurements&chatId=' + chatId;
        var response = await fetch(url);
        var data = await response.json();
        if (data.error) {
            document.getElementById('measurements-latest').innerHTML = '<div class="no-data">Ошибка: ' + data.error + '</div>';
            initMeasForm();
            return;
        }
        measurementsData = data.measurements || [];
        if (measurementsData.length === 0) {
            document.getElementById('measurements-latest').innerHTML =
                '<div class="no-data">Пока нет замеров 📏<br><br>Заполни форму ниже чтобы записать первые замеры!</div>';
            document.getElementById('measurements-list').innerHTML = '';
            // body figure is now a static image
            initMeasForm();
            return;
        }
        renderLatestMeasurements();
        // body figure is now a static image
        renderMeasurementsChart('weight');
        renderMeasurementsHistory();
        initMeasForm();
        if (!measSelectInitialized) {
            measSelectInitialized = true;
            document.getElementById('measurement-select').addEventListener('change', function(e) {
                renderMeasurementsChart(e.target.value);
            });
        }
    } catch (error) {
        console.error('Measurements load error:', error);
        document.getElementById('measurements-latest').innerHTML = '<div class="no-data">Ошибка загрузки замеров</div>';
        initMeasForm();
    }
}

function renderLatestMeasurements() {
    var latest = measurementsData[measurementsData.length - 1];
    var prev = measurementsData.length >= 2 ? measurementsData[measurementsData.length - 2] : null;
    var keys = ['weight', 'shoulders', 'chest', 'waist', 'hips', 'bicep', 'thigh'];
    var items = keys.map(function(key) {
        var val = latest[key];
        var diffHtml = '';
        if (prev && prev[key] != null && val != null) {
            var diff = (val - prev[key]).toFixed(1);
            if (diff > 0) diffHtml = '<div class="latest-item-diff diff-up">+' + diff + '</div>';
            else if (diff < 0) diffHtml = '<div class="latest-item-diff diff-down">' + diff + '</div>';
            else diffHtml = '<div class="latest-item-diff diff-neutral">0</div>';
        }
        return '<div class="latest-item">' +
            '<div class="latest-item-value">' + (val != null ? val : '—') + '</div>' +
            '<div class="latest-item-label">' + MEAS_LABELS[key] + ' (' + MEAS_UNITS[key] + ')</div>' +
            diffHtml +
        '</div>';
    }).join('');

    document.getElementById('measurements-latest').innerHTML =
        '<div class="latest-card">' +
            '<div class="latest-card-title">Последние замеры</div>' +
            '<div class="latest-card-date">' + latest.date + '</div>' +
            '<div class="latest-grid">' + items + '</div>' +
        '</div>';
}

// ===== BODY FIGURE LABELS =====

// ===== MEASUREMENTS INPUT FORM =====

var measFormInitialized = false;

function initMeasForm() {
    if (measFormInitialized) return;
    measFormInitialized = true;

    // Green highlight on filled inputs
    document.querySelectorAll('.meas-input').forEach(function(input) {
        input.addEventListener('input', function() {
            if (input.value) input.classList.add('filled');
            else input.classList.remove('filled');
        });
    });

    // Save button
    document.getElementById('meas-save-btn').addEventListener('click', saveMeasurements);
}

async function saveMeasurements() {
    var btn = document.getElementById('meas-save-btn');
    var fields = {
        weight: document.getElementById('meas-weight').value,
        shoulders: document.getElementById('meas-shoulders').value,
        chest: document.getElementById('meas-chest').value,
        waist: document.getElementById('meas-waist').value,
        hips: document.getElementById('meas-hips').value,
        bicep: document.getElementById('meas-bicep').value,
        thigh: document.getElementById('meas-thigh').value
    };

    // Check at least one field filled
    var hasAny = Object.values(fields).some(function(v) { return v && v.trim() !== ''; });
    if (!hasAny) {
        tg.showAlert('Заполни хотя бы одно поле! 📏');
        return;
    }

    btn.textContent = '⏳ Сохранение...';
    btn.classList.add('saving');
    btn.disabled = true;

    try {
        var chatId = tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : '739299264';
        var params = 'action=saveMeasurements&chatId=' + chatId;
        Object.keys(fields).forEach(function(key) {
            if (fields[key]) params += '&' + key + '=' + encodeURIComponent(fields[key]);
        });
        var url = APPS_SCRIPT_URL + '?' + params;
        var response = await fetch(url);
        var data = await response.json();

        if (data.success) {
            btn.classList.remove('saving');
            btn.classList.add('success');
            btn.textContent = '✅ Сохранено!';
            if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
            // Clear form
            document.querySelectorAll('.meas-input').forEach(function(input) {
                input.value = '';
                input.classList.remove('filled');
            });
            // Reload data
            setTimeout(function() {
                btn.classList.remove('success');
                btn.textContent = '💾 Сохранить замеры';
                btn.disabled = false;
                measSelectInitialized = false;
                loadMeasurementsData();
            }, 1500);
        } else {
            tg.showAlert('Ошибка сохранения: ' + (data.error || 'Попробуй ещё раз'));
            btn.classList.remove('saving');
            btn.textContent = '💾 Сохранить замеры';
            btn.disabled = false;
        }
    } catch (error) {
        console.error('Save measurements error:', error);
        tg.showAlert('Ошибка сохранения ❌');
        btn.classList.remove('saving');
        btn.textContent = '💾 Сохранить замеры';
        btn.disabled = false;
    }
}

function renderMeasurementsChart(key) {
    var filtered = measurementsData.filter(function(m) { return m[key] != null; });
    if (filtered.length === 0) return;
    if (measurementsChart) measurementsChart.destroy();
    var ctx = document.getElementById('measurements-chart').getContext('2d');
    var colors = {
        weight: '#E53935', shoulders: '#455A64', chest: '#1565C0', waist: '#F57C00',
        hips: '#7B1FA2', bicep: '#2E7D32', thigh: '#C62828'
    };
    var color = colors[key] || '#E53935';
    measurementsChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: filtered.map(function(m) { return m.date; }),
            datasets: [{
                label: MEAS_LABELS[key] + ' (' + MEAS_UNITS[key] + ')',
                data: filtered.map(function(m) { return m[key]; }),
                borderColor: color,
                backgroundColor: color + '1A',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 6,
                pointBackgroundColor: color,
                pointBorderColor: '#fff',
                pointBorderWidth: 2,
                pointHoverRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1a1a1a',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    padding: 12,
                    cornerRadius: 8,
                    displayColors: false
                }
            },
            scales: {
                y: {
                    grid: { color: '#f0f0f0' },
                    ticks: { callback: function(v) { return v + ' ' + MEAS_UNITS[key]; } }
                },
                x: { grid: { display: false } }
            }
        }
    });
}

function renderMeasurementsHistory() {
    var list = document.getElementById('measurements-list');
    var keys = ['weight', 'shoulders', 'chest', 'waist', 'hips', 'bicep', 'thigh'];
    var reversed = measurementsData.slice().reverse();
    list.innerHTML = reversed.map(function(m, i) {
        var values = keys.map(function(key) {
            return '<div class="measurement-row-item">' +
                '<div class="measurement-row-label">' + MEAS_LABELS[key] + '</div>' +
                '<div class="measurement-row-value">' + (m[key] != null ? m[key] + ' ' + MEAS_UNITS[key] : '—') + '</div>' +
            '</div>';
        }).join('');
        return '<div class="measurement-row" style="animation-delay:' + (i * 0.05) + 's">' +
            '<div class="measurement-row-date">📅 ' + m.date + '</div>' +
            '<div class="measurement-row-values">' + values + '</div>' +
        '</div>';
    }).join('');
}

function messageClient(chatId, name) {
    var msg = prompt('Сообщение для ' + name + ':');
    if (!msg || !msg.trim()) return;
    var url = 'https://api.telegram.org/bot' + '8752235431:AAHuCD1j65HCVd233kG1EvBm8sQX_dX9eW0' + '/sendMessage';
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: '💬 Сообщение от тренера:\n\n' + msg })
    }).then(function(resp) { return resp.json(); })
    .then(function(data) {
        if (data.ok) tg.showAlert('Сообщение отправлено! ✅');
        else tg.showAlert('Ошибка отправки ❌');
    }).catch(function() { tg.showAlert('Ошибка отправки ❌'); });
}
 