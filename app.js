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
        document.getElementById('tabs-container').classList.add('tabs-3');
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
 