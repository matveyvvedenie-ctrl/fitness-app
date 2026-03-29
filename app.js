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
 
async function init() {
    console.log('Init started...');
    try {
        const response = await loadWorkoutData();
        console.log('Data received:', response);
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
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('main-screen').classList.remove('hidden');
        initializeTabs();
        initAdminTab();
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
        var dayHeader = document.createElement('div');
        dayHeader.className = 'day-header';
        dayHeader.textContent = day.day;
        container.appendChild(dayHeader);
        day.exercises.forEach(function(exercise, exIndex) {
            var card = createExerciseCard(exercise, dayIndex, exIndex);
            container.appendChild(card);
        });
    });
    updateProgress();
}
 
function createExerciseCard(exercise, dayIndex, exIndex) {
    var card = document.createElement('div');
    card.className = 'exercise-card';
    var hasVideo = exercise.video && (exercise.video.indexOf('http') !== -1 || exercise.video.indexOf('📽️') !== -1);
    var photo1 = exercise.photo1 || '';
    var photo2 = exercise.photo2 || '';
    var photoHtml1 = photo1 ? '<img src="' + photo1 + '" alt="Photo 1" class="exercise-photo-img" onerror="this.parentElement.innerHTML=\'🏋️\'">' : '🏋️';
    var photoHtml2 = photo2 ? '<img src="' + photo2 + '" alt="Photo 2" class="exercise-photo-img" onerror="this.parentElement.innerHTML=\'💪\'">' : '💪';
    var noteHtml = exercise.note ? '<div class="trainer-note">💬 ' + exercise.note + '</div>' : '';
    var videoHtml = hasVideo ? '<button class="video-btn" onclick="openVideo(\'' + exercise.video + '\')">📹 ВИДЕО ТЕХНИКИ</button>' : '';
    var commentValue = exercise.comment || '';
    // Filter out timestamp values that accidentally got into comment field
    if (commentValue && /^\d{4}-\d{2}-\d{2}T/.test(commentValue)) commentValue = '';
    if (commentValue && /^\d{2}\.\d{2}\.\d{4}/.test(commentValue)) commentValue = '';
    card.innerHTML =
        '<div class="exercise-photos">' +
            '<div class="exercise-photo">' + photoHtml1 + '</div>' +
            '<div class="exercise-photo">' + photoHtml2 + '</div>' +
        '</div>' +
        '<div class="exercise-body">' +
            '<div class="exercise-name">' + exercise.exercise + '</div>' +
            noteHtml +
            '<div class="exercise-params">' +
                '<div class="param"><div class="param-label">Подх</div><div class="param-value">' + exercise.sets + '</div></div>' +
                '<div class="param"><div class="param-label">Повт</div><div class="param-value">' + exercise.reps + '</div></div>' +
                '<div class="param"><div class="param-label">Вес</div><div class="param-value plan">' + exercise.weightPlan + 'кг</div></div>' +
                '<div class="param"><div class="param-label">RPE</div><div class="param-value rpe">' + exercise.rpe + '</div></div>' +
            '</div>' +
            videoHtml +
            '<div class="input-row">' +
                '<input type="number" inputmode="decimal" enterkeyhint="done" class="input-field" placeholder="Вес (кг)" value="' + (exercise.weightFact || '') + '" data-day="' + dayIndex + '" data-exercise="' + exIndex + '" data-row="' + exercise.rowIndex + '" data-field="weight" onchange="handleInput(this)">' +
                '<input type="number" inputmode="numeric" enterkeyhint="done" class="input-field" placeholder="Повторения" value="' + (exercise.repsFact || '') + '" data-day="' + dayIndex + '" data-exercise="' + exIndex + '" data-row="' + exercise.rowIndex + '" data-field="reps" onchange="handleInput(this)">' +
            '</div>' +
            '<textarea class="comment-field" placeholder="Комментарий к упражнению (опционально)" data-day="' + dayIndex + '" data-exercise="' + exIndex + '" data-row="' + exercise.rowIndex + '" data-field="comment" onchange="handleInput(this)">' + commentValue + '</textarea>' +
        '</div>';
    return card;
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
                    exercisesToSave.push({
                        rowIndex: exercise.rowIndex,
                        weightFact: exercise.weightFact || '',
                        repsFact: exercise.repsFact || '',
                        completed: !!(exercise.weightFact || exercise.repsFact),
                        comment: (exercise.comment && exercise.comment.trim()) ? exercise.comment.trim() : '',
                        exercise: exercise.exercise,
                        sets: exercise.sets,
                        reps: exercise.reps,
                        weightPlan: exercise.weightPlan,
                        rpe: exercise.rpe
                    });
                }
            }
        }
        if (exercisesToSave.length === 0) {
            tg.showAlert('Нечего сохранять! Заполни вес или повторы 📝');
        } else {
            var chatId = tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : '739299264';
            var completionPercent = totalExercises > 0 ? Math.round((completedCount / totalExercises) * 100) : 0;
            var url = APPS_SCRIPT_URL + '?action=write&chatId=' + chatId + '&completionPercent=' + completionPercent + '&exercises=' + encodeURIComponent(JSON.stringify(exercisesToSave));
            var data = null;
            for (var attempt = 0; attempt < 3; attempt++) {
                try {
                    var response = await fetch(url);
                    data = await response.json();
                    if (data && data.success) break;
                } catch (err) {
                    console.log('Attempt ' + (attempt + 1) + ' failed, retrying...');
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
                tg.showAlert('Не удалось сохранить данные ❌\nПопробуй ещё раз');
            }
        }
    } catch (error) {
        console.error('Save error:', error);
        tg.showAlert('Ошибка при сохранении данных ❌');
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
            if (tabName === 'admin') loadDashboardData();
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
        });
    });
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
        var exercises = [];
        historyData.forEach(function(d) {
            if (exercises.indexOf(d.exercise) === -1) exercises.push(d.exercise);
        });
        var select = document.getElementById('exercise-select');
        select.innerHTML = '<option value="">Выберите упражнение...</option>';
        exercises.forEach(function(ex) {
            var option = document.createElement('option');
            option.value = ex;
            option.textContent = ex;
            select.appendChild(option);
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
 
function renderChart(exerciseName) {
    var data = historyData.filter(function(d) { return d.exercise === exerciseName; });
    if (data.length === 0) return;
    if (progressChart) progressChart.destroy();
    var ctx = document.getElementById('progress-chart').getContext('2d');
    progressChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(function(d) { return d.week || d.date; }),
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
            '<div class="record-name">' + record.exercise + '</div>' +
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
        document.getElementById('tabs-container').classList.add('tabs-4');
        initFilters();
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

// ========== MEASUREMENTS TAB ==========

var measurementsData = [];
var measurementsChart = null;
var measSelectInitialized = false;

var MEAS_LABELS = {
    weight: 'Вес', chest: 'Грудь', waist: 'Талия',
    hips: 'Бёдра', bicep: 'Бицепс', thigh: 'Бедро'
};
var MEAS_UNITS = {
    weight: 'кг', chest: 'см', waist: 'см',
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
            drawBodyFigure(null);
            initMeasForm();
            return;
        }
        renderLatestMeasurements();
        drawBodyFigure(measurementsData[measurementsData.length - 1]);
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
    var keys = ['weight', 'chest', 'waist', 'hips', 'bicep', 'thigh'];
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

// ===== REALISTIC BODY FIGURE ON CANVAS =====

function drawBodyFigure(data) {
    var canvas = document.getElementById('body-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Default proportions (baseline: chest=90, waist=70, hips=95, bicep=30, thigh=50)
    var chest = 90, waist = 70, hips = 95, bicep = 30, thigh = 50, weight = null;
    if (data) {
        chest = data.chest || 90;
        waist = data.waist || 70;
        hips = data.hips || 95;
        bicep = data.bicep || 30;
        thigh = data.thigh || 50;
        weight = data.weight;
    }

    // Scale measurements to pixel widths (relative to canvas)
    var cx = W / 2; // center x
    var scale = 0.55;
    var chestW = chest * scale;
    var waistW = waist * scale;
    var hipsW = hips * scale;
    var bicepW = bicep * scale * 0.45;
    var thighW = thigh * scale * 0.42;

    // Key Y positions
    var headY = 35, headR = 22;
    var neckY = headY + headR + 5;
    var shoulderY = neckY + 18;
    var chestY = shoulderY + 30;
    var waistY = chestY + 50;
    var hipY = waistY + 35;
    var kneeY = hipY + 80;
    var footY = kneeY + 75;

    // Colors
    var skinColor = '#FFD4B8';
    var outlineColor = '#C6846E';
    var labelBg = 'rgba(255,255,255,0.9)';

    // Draw body silhouette using bezier curves
    ctx.save();

    // Fill body shape
    ctx.beginPath();
    // Start at left shoulder
    ctx.moveTo(cx - chestW / 2 - 8, shoulderY);
    // Left arm (bicep width affects arm thickness)
    // Upper arm
    ctx.lineTo(cx - chestW / 2 - 25, shoulderY + 5);
    ctx.quadraticCurveTo(cx - chestW / 2 - 25 - bicepW, shoulderY + 50, cx - chestW / 2 - 20 - bicepW * 0.7, shoulderY + 75);
    // Elbow
    ctx.quadraticCurveTo(cx - chestW / 2 - 18 - bicepW * 0.5, shoulderY + 85, cx - chestW / 2 - 22, shoulderY + 95);
    // Forearm
    ctx.quadraticCurveTo(cx - chestW / 2 - 28, shoulderY + 130, cx - chestW / 2 - 18, shoulderY + 150);
    // Hand
    ctx.quadraticCurveTo(cx - chestW / 2 - 12, shoulderY + 160, cx - chestW / 2 - 8, shoulderY + 150);
    // Back up forearm
    ctx.quadraticCurveTo(cx - chestW / 2 - 5, shoulderY + 130, cx - chestW / 2 - 5, shoulderY + 95);
    ctx.quadraticCurveTo(cx - chestW / 2 - 3, shoulderY + 80, cx - chestW / 2 + 2, shoulderY + 55);
    // Back to torso left side
    ctx.lineTo(cx - chestW / 2, chestY);
    // Left torso - chest to waist to hip
    ctx.quadraticCurveTo(cx - waistW / 2, (chestY + waistY) / 2, cx - waistW / 2, waistY);
    ctx.quadraticCurveTo(cx - hipsW / 2, (waistY + hipY) / 2, cx - hipsW / 2, hipY);
    // Left leg
    ctx.quadraticCurveTo(cx - thighW - 5, hipY + 15, cx - thighW - 2, hipY + 40);
    ctx.quadraticCurveTo(cx - thighW, kneeY - 10, cx - thighW * 0.7, kneeY);
    ctx.quadraticCurveTo(cx - thighW * 0.55, kneeY + 15, cx - thighW * 0.5, kneeY + 40);
    ctx.quadraticCurveTo(cx - thighW * 0.55, footY - 15, cx - thighW * 0.6, footY);
    // Left foot
    ctx.quadraticCurveTo(cx - thighW * 0.8, footY + 10, cx - thighW * 0.6, footY + 12);
    ctx.lineTo(cx - thighW * 0.1, footY + 12);
    ctx.quadraticCurveTo(cx - thighW * 0.05, footY + 5, cx - thighW * 0.1, footY);
    // Inner left leg back up
    ctx.quadraticCurveTo(cx - thighW * 0.15, footY - 15, cx - thighW * 0.1, kneeY + 40);
    ctx.quadraticCurveTo(cx - thighW * 0.1, kneeY + 15, cx - thighW * 0.2, kneeY);
    ctx.quadraticCurveTo(cx - thighW * 0.3, kneeY - 10, cx - 5, hipY + 15);
    // Crotch
    ctx.quadraticCurveTo(cx, hipY + 25, cx + 5, hipY + 15);
    // Right inner leg
    ctx.quadraticCurveTo(cx + thighW * 0.3, kneeY - 10, cx + thighW * 0.2, kneeY);
    ctx.quadraticCurveTo(cx + thighW * 0.1, kneeY + 15, cx + thighW * 0.1, kneeY + 40);
    ctx.quadraticCurveTo(cx + thighW * 0.15, footY - 15, cx + thighW * 0.1, footY);
    // Right foot
    ctx.quadraticCurveTo(cx + thighW * 0.05, footY + 5, cx + thighW * 0.1, footY + 12);
    ctx.lineTo(cx + thighW * 0.6, footY + 12);
    ctx.quadraticCurveTo(cx + thighW * 0.8, footY + 10, cx + thighW * 0.6, footY);
    // Right outer leg
    ctx.quadraticCurveTo(cx + thighW * 0.55, footY - 15, cx + thighW * 0.5, kneeY + 40);
    ctx.quadraticCurveTo(cx + thighW * 0.55, kneeY + 15, cx + thighW * 0.7, kneeY);
    ctx.quadraticCurveTo(cx + thighW, kneeY - 10, cx + thighW + 2, hipY + 40);
    ctx.quadraticCurveTo(cx + thighW + 5, hipY + 15, cx + hipsW / 2, hipY);
    // Right torso
    ctx.quadraticCurveTo(cx + hipsW / 2, (waistY + hipY) / 2, cx + waistW / 2, waistY);
    ctx.quadraticCurveTo(cx + waistW / 2, (chestY + waistY) / 2, cx + chestW / 2, chestY);
    // Right arm back
    ctx.lineTo(cx + chestW / 2 + 2, shoulderY + 55);
    ctx.quadraticCurveTo(cx + chestW / 2 + 3, shoulderY + 80, cx + chestW / 2 + 5, shoulderY + 95);
    ctx.quadraticCurveTo(cx + chestW / 2 + 5, shoulderY + 130, cx + chestW / 2 + 8, shoulderY + 150);
    // Right hand
    ctx.quadraticCurveTo(cx + chestW / 2 + 12, shoulderY + 160, cx + chestW / 2 + 18, shoulderY + 150);
    ctx.quadraticCurveTo(cx + chestW / 2 + 28, shoulderY + 130, cx + chestW / 2 + 22, shoulderY + 95);
    ctx.quadraticCurveTo(cx + chestW / 2 + 18 + bicepW * 0.5, shoulderY + 85, cx + chestW / 2 + 20 + bicepW * 0.7, shoulderY + 75);
    ctx.quadraticCurveTo(cx + chestW / 2 + 25 + bicepW, shoulderY + 50, cx + chestW / 2 + 25, shoulderY + 5);
    ctx.lineTo(cx + chestW / 2 + 8, shoulderY);
    // Shoulders top
    ctx.quadraticCurveTo(cx + 12, shoulderY - 8, cx, neckY + 8);
    ctx.quadraticCurveTo(cx - 12, shoulderY - 8, cx - chestW / 2 - 8, shoulderY);
    ctx.closePath();

    // Fill with skin color
    var gradient = ctx.createLinearGradient(cx - 50, 0, cx + 50, 0);
    gradient.addColorStop(0, '#FFD0B0');
    gradient.addColorStop(0.5, skinColor);
    gradient.addColorStop(1, '#FFD0B0');
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Draw head
    ctx.beginPath();
    ctx.arc(cx, headY, headR, 0, Math.PI * 2);
    ctx.fillStyle = skinColor;
    ctx.fill();
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Neck
    ctx.beginPath();
    ctx.moveTo(cx - 8, headY + headR - 2);
    ctx.lineTo(cx - 10, neckY + 8);
    ctx.lineTo(cx + 10, neckY + 8);
    ctx.lineTo(cx + 8, headY + headR - 2);
    ctx.fillStyle = skinColor;
    ctx.fill();

    // Face features
    ctx.fillStyle = '#8B6F5E';
    // Eyes
    ctx.beginPath();
    ctx.arc(cx - 7, headY - 2, 2, 0, Math.PI * 2);
    ctx.arc(cx + 7, headY - 2, 2, 0, Math.PI * 2);
    ctx.fill();
    // Mouth
    ctx.beginPath();
    ctx.arc(cx, headY + 8, 5, 0.1 * Math.PI, 0.9 * Math.PI);
    ctx.strokeStyle = '#8B6F5E';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();

    // ===== MEASUREMENT LINES & LABELS =====

    function drawMeasLine(y, halfW, color, label, value, side) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(cx - halfW, y);
        ctx.lineTo(cx + halfW, y);
        ctx.stroke();
        // Arrow ends
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(cx - halfW, y - 4);
        ctx.lineTo(cx - halfW, y + 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + halfW, y - 4);
        ctx.lineTo(cx + halfW, y + 4);
        ctx.stroke();
        // Label
        var text = label + ': ' + (value != null ? value : '—');
        ctx.font = 'bold 11px -apple-system, sans-serif';
        var tw = ctx.measureText(text).width;
        var lx = side === 'left' ? 4 : W - tw - 8;
        var ly = y - 6;
        ctx.fillStyle = labelBg;
        ctx.fillRect(lx - 2, ly - 10, tw + 4, 14);
        ctx.fillStyle = color;
        ctx.fillText(text, lx, ly);
        ctx.restore();
    }

    if (data) {
        drawMeasLine(chestY, chestW / 2, '#1565C0', 'Грудь', data.chest ? data.chest + ' см' : null, 'right');
        drawMeasLine(waistY, waistW / 2, '#F57C00', 'Талия', data.waist ? data.waist + ' см' : null, 'left');
        drawMeasLine(hipY, hipsW / 2, '#7B1FA2', 'Бёдра', data.hips ? data.hips + ' см' : null, 'right');

        // Bicep label
        var bicepY = shoulderY + 50;
        ctx.save();
        ctx.strokeStyle = '#2E7D32';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.arc(cx - chestW / 2 - 15, bicepY, bicepW + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = 'bold 11px -apple-system, sans-serif';
        var bText = 'Бицепс: ' + (data.bicep ? data.bicep + ' см' : '—');
        ctx.fillStyle = labelBg;
        var btw = ctx.measureText(bText).width;
        ctx.fillRect(2, bicepY - 22, btw + 4, 14);
        ctx.fillStyle = '#2E7D32';
        ctx.fillText(bText, 4, bicepY - 10);
        ctx.restore();

        // Thigh label
        var thighLabelY = hipY + 55;
        ctx.save();
        ctx.strokeStyle = '#C62828';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.arc(cx + thighW * 0.4, thighLabelY, thighW * 0.6 + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = 'bold 11px -apple-system, sans-serif';
        var tText = 'Бедро: ' + (data.thigh ? data.thigh + ' см' : '—');
        var ttw = ctx.measureText(tText).width;
        ctx.fillStyle = labelBg;
        ctx.fillRect(W - ttw - 8, thighLabelY - 22, ttw + 4, 14);
        ctx.fillStyle = '#C62828';
        ctx.fillText(tText, W - ttw - 6, thighLabelY - 10);
        ctx.restore();

        // Weight label at bottom
        ctx.save();
        ctx.font = 'bold 16px -apple-system, sans-serif';
        var wText = weight != null ? '⚖️ ' + weight + ' кг' : '⚖️ — кг';
        var wtw = ctx.measureText(wText).width;
        ctx.fillStyle = '#E53935';
        ctx.textAlign = 'center';
        ctx.fillText(wText, cx, footY + 35);
        ctx.restore();
    }
}

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
        weight: '#E53935', chest: '#1565C0', waist: '#F57C00',
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
    var keys = ['weight', 'chest', 'waist', 'hips', 'bicep', 'thigh'];
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
 