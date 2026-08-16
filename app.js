const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyqpppW2wnxH4nAYrZDaIu0XedFB5wfOeUXXokxFz4TpslB-GqD24B9GsPp0i_nTJ4GVA/exec';

const TRAINER_CHAT_ID = '739299264';
const TRAINER_VK_CHAT_ID = 'vk_458191089'; // тот же тренер, но заходит через VK

// Мульти-тенантность: если мини-апп открыт из сообщества тренера, VK кладёт
// vk_group_id в параметры запуска — это и есть trainerId для бэкенда (см.
// apps_script.js _resolveTenant). Без него (Telegram, или VK без группы) —
// пусто, бэкенд использует тенанта по умолчанию (Matvey), как и раньше.
// НЕ const: VK не всегда пробрасывает vk_group_id в ссылку (например, если
// открыть мини-апп не той самой ссылкой из сообщения бота) — в этом случае
// бэкенд сам находит тенанта по chatId (см. _resolveTrainerIdByChatId в
// apps_script.js), а loadTenantConfig() ниже подхватывает узнанный trainerId
// и переучивает эту переменную, чтобы ВСЕ следующие запросы тоже шли верно.
let CURRENT_TRAINER_ID = new URLSearchParams(window.location.search).get('vk_group_id') || '';

// Тема текущего тенанта, подтягивается в init() через loadTenantConfig().
// tenantTrainerChatId — фоллбэк для isTrainer() у тренеров, подключённых
// после этого шага (у самого Matvey и так есть хардкод выше, на всякий случай).
let tenantTheme = null;
let tenantTrainerChatId = '';

function isTrainer(chatId) {
    return chatId === TRAINER_CHAT_ID || chatId === TRAINER_VK_CHAT_ID ||
        (!!tenantTrainerChatId && chatId === tenantTrainerChatId);
}

// Прозрачно добавляем trainerId ко всем запросам к Apps Script, не трогая
// каждый из ~40 существующих fetch(...) по всему файлу. Без CURRENT_TRAINER_ID
// (обычный Telegram-запуск или VK без группы) ничего не добавляется —
// поведение как раньше.
//
// Заодно ретраим запросы к Apps Script при СЕТЕВОМ сбое (fetch кидает
// исключение, например Safari "Load failed" / "Failed to fetch") — это
// известная особенность хостинга на script.google.com: он отдаёт 302-редирект
// на одноразовый googleusercontent.com URL, и этот "хвост" иногда рвётся без
// всякой связи с нашим кодом ("раз через раз грузит"). НЕ ретраим по статусу
// ответа (200 с {error:...} внутри — это уже настоящая ошибка, не сетевая) —
// только когда fetch вообще не смог достучаться до сервера.
//
// _withTimeout: у fetch() нет таймаута по умолчанию — если соединение просто
// зависает (не рвётся с ошибкой, а молча не отвечает — бывает во встроенных
// браузерах вроде VK-приложения на телефоне, где сеть строже), await fetch()
// висит вечно и вообще не доходит ни до catch выше, ни до отображения ошибки
// — человек видит бесконечный спиннер (см. жалобу "во VK на телефоне крутит
// загрузку бесконечно", 2026-08-12). Promise.race не отменяет сам запрос, но
// перестаёт его ждать и даёт остальному коду (ретраю/экрану ошибки) сработать.
function _withTimeout(promise, ms) {
    return new Promise(function(resolve, reject) {
        var timer = setTimeout(function() { reject(new Error('Таймаут запроса (' + (ms / 1000) + ' с)')); }, ms);
        promise.then(function(v) { clearTimeout(timer); resolve(v); },
                     function(e) { clearTimeout(timer); reject(e); });
    });
}
function _fetchWithRetry(nativeFetch, input, init, retriesLeft) {
    return _withTimeout(nativeFetch(input, init), 15000).catch(function(err) {
        if (retriesLeft <= 0) throw err;
        return new Promise(function(resolve) { setTimeout(resolve, 700); })
            .then(function() { return _fetchWithRetry(nativeFetch, input, init, retriesLeft - 1); });
    });
}

// ── Фаза 4 пилот (см. MIGRATION_PLAN.md, 2026-08-13) ────────────────────────
// Для ОДНОГО trainerId (сейчас — Роман) НЕКОТОРЫЕ read-запросы уходят не в
// Apps Script, а в новый Python API (Postgres) на Railway. Намеренно узкий
// срез — только чтение (getClients/getClientProfile/getMeasurements/
// getClientFoodEntries/getExerciseLibrary/getExerciseMediaLibrary/
// getMealPlanForClient), никакой записи. Всё остальное продолжает идти в Apps Script
// как раньше — НИКАКИХ изменений для любого другого trainerId, в том числе
// для Matvey по умолчанию (без trainerId вообще): action просто не найдётся
// в NEW_API_ACTIONS, код пойдёт по старому пути ниже, 1-в-1 как было.
// Откат — убрать id из NEW_API_PILOT_TRAINERS, без передеплоя бэкенда.
//
// NEW_API_KEY виден любому, кто откроет исходник страницы — это браузер, не
// сервер, спрятать его тут физически нельзя. Не настоящий секрет, а тот же
// уровень защиты, что был у APPS_SCRIPT_URL раньше (публичный адрес плюс
// нужно знать trainerId/chatId). Обсуждали с Matvey — приемлемо для пилота
// на пустом тенанте; для реальных данных понадобится другой механизм
// (проверка подписи VK/Telegram initData на сервере, а не общий ключ).
var NEW_API_BASE = 'https://fitness-api-fitness-bot-v2.up.railway.app';
var NEW_API_KEY = '72bdc5e9073da1309592590508c0098bcaad8139c82aeafa77438c2ed46f7e61';
var NEW_API_PILOT_TRAINERS = { '240703996': true }; // Роман

// ── Фаза 5 (2026-08-15, см. MIGRATION_PLAN.md) ──────────────────────────────
// Matvey — тенант ПО УМОЛЧАНИЮ в старой системе (_resolveTenant('') в
// apps_script.js), у него в принципе НЕТ trainerId — поэтому CURRENT_TRAINER_ID
// для него ВСЕГДА пустая строка, и NEW_API_PILOT_TRAINERS[''] никогда не
// сработает (в отличие от Романа, у которого trainerId есть в ссылке).
// НЕЛЬЗЯ просто дописать '': true в NEW_API_PILOT_TRAINERS и переиспользовать
// CURRENT_TRAINER_ID как есть — эта же переменная used для трейлинга
// ?trainerId=... к запросам в СТАРЫЙ Apps Script (см. ниже, isAppsScript-ветка);
// если её подменить на 739299264, apps_script.js._resolveTenant('739299264')
// не найдёт такую строку в реестре "Тренеры" (Matvey там не зарегистрирован,
// он и есть дефолт) — и ВСЁ, что ещё не перенесено, разом сломается на
// старом бэкенде. Поэтому — отдельная функция ТОЛЬКО для путей к новому API,
// CURRENT_TRAINER_ID остаётся нетронутым везде, где он был раньше.
//
// "Это точно Matvey" различаем узко и консервативно: пустой CURRENT_TRAINER_ID
// (не Роман, не какой-то другой тенант) И запуск НЕ через VK-без-группы
// (vkLaunchUserId, см. ниже по файлу — объявлена как var, но код здесь
// исполняется лишь при вызовах fetch НАМНОГО позже разбора скрипта, так что
// объявление уже отработает к моменту вызова). Архитектурно у Matvey только
// Telegram-бот (bot.py, один токен, один тенант) — остальные тренеры/их
// клиенты заходят через vk_bot.py, всегда СО своим vk_group_id. Значит
// пустой CURRENT_TRAINER_ID + Telegram = однозначно Matvey, без гадания.
// VK-запуск БЕЗ группы сознательно НЕ трогаем — у старой системы там есть
// отдельный фоллбэк-резолвинг по chatId (_resolveTrainerIdByChatId), который
// в теории может привести к ЛЮБОМУ тренеру, а не только к Matvey — гадать
// на фронте не будем, оставляем такой запуск на старом бэкенде как есть.
var NEW_API_DEFAULT_TENANT_TRAINER_ID = '739299264'; // Matvey, см. DEFAULT_TRAINER_CHAT_ID в apps_script.js
var NEW_API_DEFAULT_TENANT_PILOT = false; // 2026-08-16 — ОТКАЧЕНО: реальные клиенты увидели сломанные историю/фото/статусы дней сразу после включения, см. MIGRATION_PLAN.md

function _newApiTrainerId() {
    if (NEW_API_PILOT_TRAINERS[CURRENT_TRAINER_ID]) return CURRENT_TRAINER_ID;
    if (NEW_API_DEFAULT_TENANT_PILOT && !CURRENT_TRAINER_ID && !vkLaunchUserId) return NEW_API_DEFAULT_TENANT_TRAINER_ID;
    return '';
}

function _fakeJsonResponse(obj, status) {
    return new Response(JSON.stringify(obj), { status: status, headers: { 'Content-Type': 'application/json' } });
}

// Заголовки для запросов к новому API. Для дефолт-тенанта (Matvey, реальные
// клиенты/деньги, см. MIGRATION_PLAN.md Фаза 5) бэкенд ТРЕБУЕТ ещё и
// X-Telegram-Init-Data (см. api/telegram_auth.py) — X-Api-Key один сам по
// себе виден в исходнике страницы (GitHub Pages публичен), initData
// подделать нельзя без токена бота, которого во фронтенде нет и не будет.
// Для остальных тренеров (Роман и т.п., пока без реальных денег/данных)
// пока достаточно X-Api-Key, как и раньше — сознательно узкая правка.
function _newApiHeaders(extra) {
    var headers = { 'X-Api-Key': NEW_API_KEY };
    if (extra) { for (var k in extra) headers[k] = extra[k]; }
    if (_newApiTrainerId() === NEW_API_DEFAULT_TENANT_TRAINER_ID && tg && tg.initData) {
        headers['X-Telegram-Init-Data'] = tg.initData;
    }
    return headers;
}

function _newApiCall(nativeFetch, path) {
    return nativeFetch(NEW_API_BASE + path, { headers: _newApiHeaders() })
        .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, status: r.status, data: data }; }); });
}

// getClientHistory/getLastExerciseResult в старой системе ключуются по имени
// клиента (общий лист "Заметки"/"История" на тренера), не по chatId — новый
// API ключует по chatId. Резолвим через уже готовый список клиентов (лишний
// запрос, но эти экшены и так не самые частые). Кэш на время жизни вкладки —
// список клиентов Романа меняется редко, а если что — просто обновит страницу.
var _nameToChatIdCache = null;
function _resolveChatIdByName(nativeFetch, name) {
    if (_nameToChatIdCache) return Promise.resolve(_nameToChatIdCache[name] || null);
    var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients';
    return _newApiCall(nativeFetch, path).then(function(res) {
        _nameToChatIdCache = {};
        (res.ok ? (res.data.clients || []) : []).forEach(function(c) { _nameToChatIdCache[c.name] = c.chatId; });
        return _nameToChatIdCache[name] || null;
    });
}

// Общее преобразование ответа GET .../program под то, что ждёт старый
// фронтенд-код (readWorkoutData/readClientProgram в apps_script.js) — общее
// между readClientProgram (тренер смотрит ЧУЖУЮ программу) и read (клиент
// смотрит СВОЮ). rowIndex — это integer `id` из новой БД под старым именем
// поля, как и везде в этом файле. photo1/photo2/videoVk — раньше отдавались
// пустыми (файлового хранилища для фото ещё не было), бэкенд теперь сам
// матчит их из библиотеки упражнений по имени (см. _exercise_photo_map в
// main.py) — просто прокидываем как есть. completed/timestamp — были
// пустышками и в оригинале, не трогаем.
function _mapProgramDays(rawDays) {
    return (rawDays || []).map(function(day) {
        return {
            day: day.day,
            exercises: (day.exercises || []).map(function(ex) {
                return {
                    rowIndex: ex.id, exercise: ex.exercise, sets: ex.sets, reps: ex.reps,
                    weightPlan: ex.weightPlan, rpe: ex.rpe, video: ex.video || '', videoVk: ex.videoVk || '',
                    note: ex.note, weightFact: ex.weightFact, repsFact: ex.repsFact,
                    completed: false, timestamp: '', comment: ex.comment,
                    photo1: ex.photo1 || '', photo2: ex.photo2 || ''
                };
            })
        };
    });
}

// Портировано 1-в-1 из _rpeToFeedback в apps_script.js — новый API отдаёт
// голый rpe, бейдж "Легко/Норм/Тяжело/Не вытянул" собираем на лету.
function _rpeToFeedback(rpe) {
    if (rpe === '' || rpe == null) return null;
    var n = parseFloat(rpe);
    if (isNaN(n)) return null;
    if (n <= 6.5) return { code: 'easy', label: 'Легко', emoji: '😌' };
    if (n <= 8.5) return { code: 'normal', label: 'Норм', emoji: '💪' };
    if (n <= 9.5) return { code: 'hard', label: 'Тяжело', emoji: '🔥' };
    return { code: 'failed', label: 'Не вытянул', emoji: '❌' };
}

// ISO-datetime ("2026-08-13T09:32:16...") -> "dd.MM.yyyy HH:mm", как раньше
// писал apps_script.js. Локальное время браузера — старая система брала
// таймзону скрипта (Europe/Moscow), тут для заметки-другой разница в часовом
// поясе не критична, а усложнять ради этого не стоит.
function _fmtDateTime(iso) {
    try {
        var d = new Date(iso);
        var p2 = function(n) { return (n < 10 ? '0' : '') + n; };
        return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    } catch (_) { return iso; }
}

// ISO-дата ("yyyy-MM-dd", без времени) -> "dd.MM.yyyy". Вынесено сюда, было
// продублировано в getClientHistory и getFinances.
function _isoDateToRu(iso) {
    if (!iso) return '';
    var parts = iso.split('-');
    return parts.length === 3 ? (parts[2] + '.' + parts[1] + '.' + parts[0]) : iso;
}

var NEW_API_ACTIONS = {
    // Аналог action=getClients — форма ответа та же ({clients:[...]}), плюс
    // синтетический sheetName (реальных "листов" в новой БД нет; часть
    // старого кода его ожидает — например открытие программы клиента, что
    // пилотом пока не покрыто и честно упадёт "Sheet not found" на старом
    // бэкенде, если попробовать — это ожидаемый пробел, не баг).
    getClients: function(nativeFetch) {
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Ошибка' }, 200);
            var clients = (res.data.clients || []).map(function(c) {
                return { chatId: c.chatId, name: c.name, archived: c.archived, sheetName: c.name };
            });
            return _fakeJsonResponse({ clients: clients }, 200);
        });
    },
    // Аналог action=getClientProfile (targetChatId/clientChatId) — добавляем
    // success:true, старый код это проверяет.
    getClientProfile: function(nativeFetch, params) {
        var chatId = params.get('targetChatId') || params.get('clientChatId') || '';
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/profile';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Клиент не найден' }, 200);
            res.data.success = true;
            return _fakeJsonResponse(res.data, 200);
        });
    },
    // Дальше — ещё 4 read-экшена (2026-08-13), формы ответа у нового API уже
    // совпадают со старыми 1-в-1 (.measurements/.days/.exercises/.exists),
    // реформатировать почти нечего — только 404 клиента в {error:...}.
    getMeasurements: function(nativeFetch, params) {
        var chatId = params.get('chatId') || '';
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/measurements';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Клиент не найден' }, 200);
            return _fakeJsonResponse(res.data, 200);
        });
    },
    getClientFoodEntries: function(nativeFetch, params) {
        var chatId = params.get('clientChatId') || params.get('chatId') || '';
        var days = params.get('days') || '14';
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) +
            '/food-entries?days=' + encodeURIComponent(days);
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Клиент не найден' }, 200);
            return _fakeJsonResponse(res.data, 200);
        });
    },
    // getExerciseLibrary и getExerciseMediaLibrary — один и тот же новый
    // эндпоинт (там уже расширенная форма с фото/видео, старому "простому"
    // getExerciseLibrary лишние поля не мешают).
    getExerciseLibrary: function(nativeFetch) {
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/exercises';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Ошибка' }, 200);
            return _fakeJsonResponse(res.data, 200);
        });
    },
    getMealPlanForClient: function(nativeFetch, params) {
        var chatId = params.get('targetChatId') || params.get('clientChatId') || '';
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/meal-plan';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Клиент не найден' }, 200);
            return _fakeJsonResponse(res.data, 200);
        });
    },
    // Ключуются по имени клиента (см. _resolveChatIdByName выше) — единственная
    // причина, почему их не добавили в прошлый раз вместе с остальным read.
    getClientHistory: function(nativeFetch, params) {
        var clientName = params.get('clientName') || '';
        var limit = params.get('limit') || '30';
        return _resolveChatIdByName(nativeFetch, clientName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ history: [] }, 200);
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) +
                '/history?limit=' + encodeURIComponent(limit);
            return _newApiCall(nativeFetch, path).then(function(res) {
                if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Ошибка' }, 200);
                // Реформатируем под то, что ждёт renderClientHistory: dateObj
                // (эпоха мс, дефолта нет — формула в formatHistoryDate/daysAgoLabel
                // упадёт в NaN без него), date как "dd.MM.yyyy", feedback по RPE.
                var history = (res.data.history || []).map(function(day) {
                    return {
                        date: _isoDateToRu(day.date), dateObj: Date.parse(day.date + 'T00:00:00'), key: day.date,
                        exercises: (day.exercises || []).map(function(ex) {
                            var out = {};
                            for (var k in ex) out[k] = ex[k];
                            out.feedback = _rpeToFeedback(ex.rpe);
                            return out;
                        })
                    };
                });
                return _fakeJsonResponse({ history: history }, 200);
            });
        });
    },
    getLastExerciseResult: function(nativeFetch, params) {
        var clientName = params.get('clientName') || '';
        var exerciseName = params.get('exerciseName') || '';
        return _resolveChatIdByName(nativeFetch, clientName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ empty: true }, 200);
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) +
                '/exercises/' + encodeURIComponent(exerciseName) + '/last-result';
            return _newApiCall(nativeFetch, path).then(function(res) {
                if (!res.ok || res.data.empty) return _fakeJsonResponse({ empty: true }, 200);
                res.data.feedback = _rpeToFeedback(res.data.rpe);
                return _fakeJsonResponse(res.data, 200);
            });
        });
    },
    // Заметки — читаем И пишем вместе (не по одной, как остальное): удаление
    // ссылается на идентификатор заметки (`ts` в старой системе), и если бы
    // читали через новый API, а удаляли через старый (или наоборот), номера
    // разъехались бы. Тут `ts`, который видит фронтенд — это просто integer
    // `id` из новой БД, переданный под старым именем поля (фронт с ним не
    // делает ничего, кроме как отдаёт обратно при удалении — см. deleteClientNoteFlow).
    getClientNotes: function(nativeFetch, params) {
        var clientName = params.get('clientName') || '';
        return _resolveChatIdByName(nativeFetch, clientName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ notes: [] }, 200);
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/notes';
            return _newApiCall(nativeFetch, path).then(function(res) {
                if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Ошибка' }, 200);
                var notes = (res.data.notes || []).map(function(n) {
                    return { date: _fmtDateTime(n.date), text: n.text, important: n.important, ts: n.id };
                });
                return _fakeJsonResponse({ notes: notes }, 200);
            });
        });
    },
    addClientNote: function(nativeFetch, params) {
        var clientName = params.get('clientName') || '';
        var text = params.get('text') || '';
        var important = params.get('important') === 'true';
        return _resolveChatIdByName(nativeFetch, clientName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ success: false, error: 'Клиент не найден' }, 200);
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/notes';
            return nativeFetch(NEW_API_BASE + path, {
                method: 'POST', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ text: text, important: important })
            }).then(function(r) { return r.json().then(function(data) {
                if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
                return _fakeJsonResponse({ success: true, ts: data.id, date: _fmtDateTime(data.date) }, 200);
            }); });
        });
    },
    deleteClientNote: function(nativeFetch, params) {
        var clientName = params.get('clientName') || '';
        var ts = params.get('ts') || ''; // на самом деле id из новой БД, см. комментарий выше
        return _resolveChatIdByName(nativeFetch, clientName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ success: false, error: 'Клиент не найден' }, 200);
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/notes/' + encodeURIComponent(ts);
            return nativeFetch(NEW_API_BASE + path, { method: 'DELETE', headers: _newApiHeaders() })
                .then(function(r) {
                    if (r.status === 204 || r.ok) return _fakeJsonResponse({ success: true }, 200);
                    return r.json().then(function(data) {
                        return _fakeJsonResponse({ success: false, error: (data && data.detail) || 'Заметка не найдена' }, 200);
                    });
                });
        });
    },
    // Аналог action=createNewClient. Копирование программы у другого клиента
    // (programOpts.type === 'copy') новый бэкенд не умеет — там нет
    // отдельного "листа программы", который можно было бы скопировать (см.
    // docstring create_client в api/main.py: клиент создаётся без единой
    // недели, пока тренер не добавит первое упражнение). В этом случае честно
    // отдаём null — уходит в старый Apps Script, тот же приём, что и у фото в
    // saveMeasurements ниже. Только programOpts.type === 'blank' (пустая
    // программа) перехватываем.
    createNewClient: function(nativeFetch, params) {
        var profile = JSON.parse(params.get('profile') || '{}');
        var programOpts = JSON.parse(params.get('programOpts') || '{}');
        if (programOpts.type === 'copy') return null; // фолбэк на старый бэкенд
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients';
        return nativeFetch(NEW_API_BASE + path, {
            method: 'POST', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(profile)
        }).then(function(r) { return r.json().then(function(data) {
            if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
            return _fakeJsonResponse({ success: true, chatId: data.chatId, name: data.name }, 200);
        }); });
    },
    // Симметричная запись к уже готовому чтению — форма ответа у обоих уже
    // {success:true[, ...]}, как ждёт старый код, реформатировать нечего.
    updateClientProfile: function(nativeFetch, params) {
        var chatId = params.get('targetChatId') || params.get('clientChatId') || '';
        var fields = {};
        _PROFILE_KEYS.forEach(function(k) { if (params.has(k)) fields[k] = params.get(k); });
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/profile';
        return nativeFetch(NEW_API_BASE + path, {
            method: 'PATCH', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(fields)
        }).then(function(r) { return r.json().then(function(data) {
            if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
            return _fakeJsonResponse(data, 200);
        }); });
    },
    // Аналог action=renameClientChatId/setClientChatId — тренер поправляет
    // chat_id клиента (например, завели по Telegram id, а клиент зашёл
    // через VK). У нового API есть уникальный индекс (trainer_id, chat_id)
    // — попытка поставить уже занятый chat_id честно возвращает ошибку
    // вместо тихой коллизии строк, как было бы в старой системе. Сбрасываем
    // кэш имя→chatId (см. _resolveChatIdByName выше) — иначе он бы молча
    // отдавал старый chatId до перезагрузки страницы.
    renameClientChatId: function(nativeFetch, params) {
        var oldChatId = params.get('oldChatId') || '';
        var newChatId = params.get('newChatId') || '';
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(oldChatId) + '/chat-id';
        return nativeFetch(NEW_API_BASE + path, {
            method: 'PATCH', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ newChatId: newChatId })
        }).then(function(r) { return r.json().then(function(data) {
            if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
            _nameToChatIdCache = null;
            return _fakeJsonResponse({ success: true }, 200);
        }); });
    },
    setClientArchived: function(nativeFetch, params) {
        var chatId = params.get('targetChatId') || params.get('clientChatId') || '';
        var archived = params.get('archived') === 'true';
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId);
        return nativeFetch(NEW_API_BASE + path, {
            method: 'PATCH', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ archived: archived })
        }).then(function(r) { return r.json().then(function(data) {
            if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
            return _fakeJsonResponse(data, 200);
        }); });
    },
    // Аналог action=deleteClient — НЕ настоящее удаление (как и в
    // оригинале): бэкенд помечает клиента статусом 'deleted', данные
    // (программа/питание/замеры) остаются в базе целыми, клиент просто
    // пропадает из getClients и получает 404 при любом обращении — тот же
    // эффект, что и был ("клиент потерял доступ к боту"), без потери
    // истории. См. docstring delete_client в api/main.py.
    deleteClient: function(nativeFetch, params) {
        var chatId = params.get('targetChatId') || params.get('clientChatId') || '';
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId);
        return nativeFetch(NEW_API_BASE + path, { method: 'DELETE', headers: _newApiHeaders() })
            .then(function(r) { return r.json().then(function(data) {
                if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
                return _fakeJsonResponse({ success: true }, 200);
            }); });
    },
    // Фото замера (photoBase64) новый API пока не умеет хранить (нет файлового
    // хранилища на бэкенде, см. DB_SCHEMA.md) — честно НЕ перехватываем такой
    // вызов (возвращаем null), он уйдёт по старому пути и фото не потеряется.
    // Без фото — сохраняем как обычно.
    saveMeasurements: function(nativeFetch, params, init) {
        var chatId = params.get('chatId') || '';
        var body;
        try { body = JSON.parse((init && init.body) || '{}'); } catch (_) { body = {}; }
        if (body.photoBase64) return null; // фолбэк на старый бэкенд, см. коммент выше
        var payload = {};
        ['weight', 'shoulders', 'chest', 'waist', 'hips', 'bicep', 'thigh'].forEach(function(k) {
            if (body[k] !== undefined && body[k] !== '') payload[k] = parseFloat(body[k]);
        });
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/measurements';
        return nativeFetch(NEW_API_BASE + path, {
            method: 'POST', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload)
        }).then(function(r) { return r.json().then(function(data) {
            if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
            return _fakeJsonResponse({ success: true }, 200);
        }); });
    },
    // client_name в теле запроса (не chatId!) — та же причина, что и у
    // заметок/истории, резолвим тем же кэшем.
    saveMealPlan: function(nativeFetch, params, init) {
        var body;
        try { body = JSON.parse((init && init.body) || '{}'); } catch (_) { body = {}; }
        var clientName = body.client_name || '';
        var plan = body.plan || {};
        return _resolveChatIdByName(nativeFetch, clientName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ success: false, error: 'Клиент не найден: ' + clientName }, 200);
            var payload = {
                target_calories: plan.target_calories || 0, target_protein: plan.target_protein || 0,
                target_fats: plan.target_fats || 0, target_carbs: plan.target_carbs || 0,
                meals: plan.meals || [], notes: plan.notes || ''
            };
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/meal-plan';
            return nativeFetch(NEW_API_BASE + path, {
                method: 'POST', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload)
            }).then(function(r) { return r.json().then(function(data) {
                if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
                return _fakeJsonResponse({ success: true }, 200);
            }); });
        });
    },
    // Форма ответа отличается от старой (у нас lastPayment — вложенный объект,
    // раньше были плоские amount/endDate) — реформатируем под то, что ждут
    // renderFinanceSummary/renderFinanceList.
    getFinances: function(nativeFetch) {
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/finances';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Ошибка' }, 200);
            var clients = (res.data.clients || []).map(function(c) {
                var p = c.lastPayment || {};
                return { chatId: c.chatId, name: c.name, status: c.status, daysLeft: c.daysLeft, endDate: _isoDateToRu(p.endDate), amount: p.amount };
            });
            return _fakeJsonResponse({ clients: clients }, 200);
        });
    },
    // savePaymentDirect в apps_script.js — тонкая обёртка над той же
    // savePayment(), на которую уже равнялся POST .../payments при разработке
    // бэкенда — семантика (продление от конца активного периода) совпадает.
    savePaymentDirect: function(nativeFetch, params) {
        var chatId = params.get('clientChatId') || params.get('chatId') || '';
        var payload = {
            amount: parseFloat(params.get('amount') || '0'), months: parseInt(params.get('months') || '1', 10),
            comment: params.get('comment') || ''
        };
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/payments';
        return nativeFetch(NEW_API_BASE + path, {
            method: 'POST', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload)
        }).then(function(r) { return r.json().then(function(data) {
            if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
            return _fakeJsonResponse({
                success: true, clientName: params.get('clientName') || '', amount: data.amount,
                months: data.months, endDate: _isoDateToRu(data.endDate), paymentDate: _isoDateToRu(data.date)
            }, 200);
        }); });
    },
    adjustSubscriptionEnd: function(nativeFetch, params) {
        var chatId = params.get('clientChatId') || params.get('chatId') || '';
        var payload = { days: parseInt(params.get('days') || '0', 10), comment: params.get('comment') || '' };
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/payments/adjust';
        return nativeFetch(NEW_API_BASE + path, {
            method: 'POST', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload)
        }).then(function(r) { return r.json().then(function(data) {
            if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
            return _fakeJsonResponse({ success: true, newEndDate: _isoDateToRu(data.endDate) }, 200);
        }); });
    },
    // Программа тренировок — ключуется по sheetName (не chatId), но у нас
    // sheetName === name синтетически (см. getClients выше), так что
    // подходит тот же резолвер _resolveChatIdByName. rowIndex, который видит
    // фронтенд — это integer `id` из новой БД под старым именем поля (тот же
    // приём, что и с `ts` у заметок). Читаем И пишем вместе — если бы читали
    // из новой системы, а писали в старую (или наоборот), id/rowIndex
    // разъехались бы мгновенно.
    //
    // НЕ переносим тут: photo1/photo2/videoVk (фото/VK-видео техники — совпадение
    // по названию с библиотекой упражнений, у Романа она пуста, деградация
    // не критична), completed/timestamp (были всегда пустышками и в
    // apps_script.js), action=write (клиент сам завершает тренировку — там
    // ещё и опрос самочувствия/причина провала, которых на бэкенде пока нет,
    // а настоящих клиентов у Романа всё равно нет — не горит).
    readClientProgram: function(nativeFetch, params) {
        var sheetName = params.get('sheetName') || '';
        return _resolveChatIdByName(nativeFetch, sheetName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ error: 'Sheet not found: ' + sheetName }, 200);
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/program';
            return _newApiCall(nativeFetch, path).then(function(res) {
                if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Ошибка' }, 200);
                return _fakeJsonResponse({ weekTitle: res.data.weekTitle, days: _mapProgramDays(res.data.days) }, 200);
            });
        });
    },
    // Аналог action=read — КЛИЕНТ читает СВОЮ программу (chatId — его
    // собственный, из _myChatId(), не резолвер по имени, он и так свой
    // chatId знает). Тот же бэкенд-эндпоинт и то же преобразование дней,
    // что у readClientProgram (трenerской версии просмотра ЧУЖОЙ
    // программы) — вынесено в общий _mapProgramDays. Добавляем clientName
    // в ответ (в оригинале read кладёт его отдельно поверх readWorkoutData,
    // readClientProgram — нет, ей это поле не нужно).
    read: function(nativeFetch, params) {
        var chatId = params.get('chatId') || '';
        if (!chatId) return _fakeJsonResponse({ error: 'Missing chatId' }, 200);
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/program';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) {
                // init() в app.js регексом ищет в тексте ошибки именно
                // английское "Client not found" (см. getClientSheet в
                // apps_script.js) — по нему решает, показать тренеру
                // админку или клиенту экран запроса доступа в VK. Бэкенд
                // отдаёт русский текст в detail — на 404 подменяем на
                // оригинальную формулировку, чтобы этот механизм не сломался.
                var msg = res.status === 404
                    ? 'Client not found for chatId: ' + chatId
                    : ((res.data && res.data.detail) || 'Ошибка');
                return _fakeJsonResponse({ error: msg }, 200);
            }
            return _fakeJsonResponse({
                weekTitle: res.data.weekTitle, days: _mapProgramDays(res.data.days),
                clientName: res.data.clientName || ''
            }, 200);
        });
    },
    // Аналог action=history — КЛИЕНТСКАЯ версия (chatId свой, не резолвер по
    // имени). НЕ путать с getClientHistory (тренерская, другой экшен, другая
    // форма ответа — группирует по дню с RPE-бейджами). Эта — плоский список
    // (дата, упражнение, вес) для графика прогресса и топ-5 рекордов на
    // клиентском экране. Бэкенд уже отдаёт ровно эту форму — реформатировать
    // нечего.
    history: function(nativeFetch, params) {
        var chatId = params.get('chatId') || '';
        if (!chatId) return _fakeJsonResponse({ error: 'Missing chatId' }, 200);
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/history-flat';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) {
                var msg = res.status === 404
                    ? 'Client not found for chatId: ' + chatId
                    : ((res.data && res.data.detail) || 'Ошибка');
                return _fakeJsonResponse({ error: msg }, 200);
            }
            return _fakeJsonResponse(res.data, 200);
        });
    },
    // Аналог action=notifyClient — тренер шлёт клиенту произвольное
    // сообщение (или дефолтное "программа обновлена") через Telegram/VK.
    // 2026-08-15: токены бота добавлены в новый сервис (то же решение, что
    // и у sendMonthlyReportToClient/requestAccess ниже), прямой chatId,
    // резолвер имени не нужен.
    notifyClient: function(nativeFetch, params) {
        var chatId = params.get('targetChatId') || params.get('clientChatId') || '';
        var message = params.get('message') || '';
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/notify';
        return nativeFetch(NEW_API_BASE + path, {
            method: 'POST', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ message: message || null })
        }).then(function(r) { return r.json().then(function(data) {
            if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
            return _fakeJsonResponse({ success: true }, 200);
        }); });
    },
    // Аналог action=sendMonthlyReportToClient — clientName с фронта не
    // нужен, бэкенд сам знает имя клиента по chatId (строит тот же отчёт,
    // что уже показывает getMonthlyReportsPreview, и реально его шлёт).
    sendMonthlyReportToClient: function(nativeFetch, params) {
        var chatId = params.get('targetChatId') || params.get('clientChatId') || '';
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/monthly-report/send';
        return nativeFetch(NEW_API_BASE + path, { method: 'POST', headers: _newApiHeaders() })
            .then(function(r) { return r.json().then(function(data) {
                if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'нет данных для отчёта' }, 200);
                return _fakeJsonResponse({ success: true }, 200);
            }); });
    },
    // Аналог action=requestAccess — уведомление уходит ТРЕНЕРУ (не
    // клиенту), chatId в параметрах — это chatId ПРОСЯЩЕГО доступ (обычно
    // ещё не зарегистрированный клиент), не текущего тренера.
    requestAccess: function(nativeFetch, params) {
        var chatId = params.get('chatId') || '';
        var name = params.get('name') || '';
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/request-access';
        return nativeFetch(NEW_API_BASE + path, {
            method: 'POST', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ chatId: chatId, name: name })
        }).then(function(r) { return r.json().then(function(data) {
            if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
            return _fakeJsonResponse({ success: true }, 200);
        }); });
    },
    updateClientExercise: function(nativeFetch, params) {
        var sheetName = params.get('sheetName') || '';
        var rowIndex = params.get('rowIndex') || ''; // на самом деле id, см. коммент выше
        return _resolveChatIdByName(nativeFetch, sheetName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ success: false, error: 'Sheet not found: ' + sheetName }, 200);
            var fields = {};
            ['exercise', 'sets', 'reps', 'weightPlan', 'rpe', 'note'].forEach(function(k) {
                if (params.has(k)) fields[k] = params.get(k);
            });
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) +
                '/program/exercises/' + encodeURIComponent(rowIndex);
            return nativeFetch(NEW_API_BASE + path, {
                method: 'PATCH', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(fields)
            }).then(function(r) { return r.json().then(function(data) {
                if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
                return _fakeJsonResponse({ success: true }, 200);
            }); });
        });
    },
    deleteClientExercise: function(nativeFetch, params) {
        var sheetName = params.get('sheetName') || '';
        var rowIndex = params.get('rowIndex') || '';
        return _resolveChatIdByName(nativeFetch, sheetName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ success: false, error: 'Sheet not found: ' + sheetName }, 200);
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) +
                '/program/exercises/' + encodeURIComponent(rowIndex);
            return nativeFetch(NEW_API_BASE + path, { method: 'DELETE', headers: _newApiHeaders() })
                .then(function(r) {
                    if (r.status === 204 || r.ok) return _fakeJsonResponse({ success: true }, 200);
                    return r.json().then(function(data) {
                        return _fakeJsonResponse({ success: false, error: (data && data.detail) || 'Не удалось' }, 200);
                    });
                });
        });
    },
    // Bulk (сет/трисет/несколько упражнений разом) — новый API умеет только
    // по одному, поэтому шлём N последовательных POST вместо одного bulk-запроса.
    addClientExercises: function(nativeFetch, params, init) {
        var sheetName = params.get('sheetName') || '';
        var dayName = params.get('dayName') || '';
        var body;
        try { body = JSON.parse((init && init.body) || '{}'); } catch (_) { body = {}; }
        var exercises = body.exercises || [];
        return _resolveChatIdByName(nativeFetch, sheetName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ success: false, error: 'Sheet not found: ' + sheetName }, 200);
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/program/exercises';
            var chain = Promise.resolve();
            var savedCount = 0;
            var firstError = null;
            exercises.forEach(function(ex) {
                chain = chain.then(function() {
                    return nativeFetch(NEW_API_BASE + path, {
                        method: 'POST', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify({
                            day: dayName, exercise: ex.exercise || '', sets: ex.sets || '', reps: ex.reps || '',
                            weightPlan: ex.weightPlan || '', rpe: ex.rpe || '', note: ex.note || ''
                        })
                    }).then(function(r) { return r.json().then(function(data) {
                        if (r.ok) savedCount++;
                        else if (!firstError) firstError = data.detail || 'Не удалось';
                    }); });
                });
            });
            return chain.then(function() {
                if (firstError && savedCount === 0) return _fakeJsonResponse({ success: false, error: firstError }, 200);
                return _fakeJsonResponse({ success: true, saved: savedCount }, 200);
            });
        });
    },
    // Управление днями/неделями. addClientDay (добавить ПУСТОЙ день, без
    // единого упражнения) сюда намеренно НЕ включён — в новой модели день не
    // отдельная сущность, а просто day_name на упражнениях, пустого дня без
    // упражнений просто не существует. Если понадобится в новой системе —
    // тренер добавляет день сразу с первым упражнением через "+ добавить
    // упражнение" (addClientExercises и так создаёт день на лету). Пока
    // action=addClientDay не перехватывается — уйдёт в старый Apps Script
    // как раньше (день появится там, не здесь, до первого exercises-запроса
    // в него на новой стороне).
    renameClientDay: function(nativeFetch, params) {
        var sheetName = params.get('sheetName') || '';
        var oldDayName = params.get('oldDayName') || '';
        var newDayName = params.get('newDayName') || '';
        return _resolveChatIdByName(nativeFetch, sheetName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ success: false, error: 'Sheet not found: ' + sheetName }, 200);
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) +
                '/program/days/' + encodeURIComponent(oldDayName);
            return nativeFetch(NEW_API_BASE + path, {
                method: 'PATCH', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ newName: newDayName })
            }).then(function(r) { return r.json().then(function(data) {
                if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
                return _fakeJsonResponse({ success: true }, 200);
            }); });
        });
    },
    deleteClientDay: function(nativeFetch, params) {
        var sheetName = params.get('sheetName') || '';
        var dayName = params.get('dayName') || '';
        return _resolveChatIdByName(nativeFetch, sheetName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ success: false, error: 'Sheet not found: ' + sheetName }, 200);
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) +
                '/program/days/' + encodeURIComponent(dayName);
            return nativeFetch(NEW_API_BASE + path, { method: 'DELETE', headers: _newApiHeaders() })
                .then(function(r) { return r.json().then(function(data) {
                    if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
                    return _fakeJsonResponse({ success: true }, 200);
                }); });
        });
    },
    // Старый API даёт только плоский список rowIndex без явного dayName —
    // все переставляемые строки уже гарантированно из одного дня (визуально
    // тащат только внутри одной секции), так что находим день по первому id.
    reorderDayExercises: function(nativeFetch, params) {
        var sheetName = params.get('sheetName') || '';
        var order = (params.get('order') || '').split(',').map(function(s) { return parseInt(s.trim(), 10); }).filter(function(n) { return !isNaN(n); });
        if (order.length === 0) return _fakeJsonResponse({ success: false, error: 'Empty order' }, 200);
        return _resolveChatIdByName(nativeFetch, sheetName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ success: false, error: 'Sheet not found: ' + sheetName }, 200);
            var progPath = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/program';
            return _newApiCall(nativeFetch, progPath).then(function(res) {
                if (!res.ok) return _fakeJsonResponse({ success: false, error: (res.data && res.data.detail) || 'Ошибка' }, 200);
                var dayName = null;
                (res.data.days || []).forEach(function(day) {
                    if (day.exercises.some(function(ex) { return ex.id === order[0]; })) dayName = day.day;
                });
                if (!dayName) return _fakeJsonResponse({ success: false, error: 'День не найден' }, 200);
                var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) +
                    '/program/days/' + encodeURIComponent(dayName) + '/reorder';
                return nativeFetch(NEW_API_BASE + path, {
                    method: 'PUT', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ orderedIds: order })
                }).then(function(r) { return r.json().then(function(data) {
                    if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
                    return _fakeJsonResponse({ success: true }, 200);
                }); });
            });
        });
    },
    // БЕЗ autoProgress (авто-подбор весов по фактам прошлой недели) — новый
    // бэкенд его не умеет, параметр тихо игнорируется (неделя дублируется
    // как есть, план копируется, факты чистые — то же самое, что autoProgress
    // выключенный вручную).
    duplicateClientWeek: function(nativeFetch, params) {
        var sheetName = params.get('sheetName') || '';
        return _resolveChatIdByName(nativeFetch, sheetName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ success: false, error: 'Sheet not found: ' + sheetName }, 200);
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/program/duplicate-week';
            return nativeFetch(NEW_API_BASE + path, { method: 'POST', headers: _newApiHeaders() })
                .then(function(r) { return r.json().then(function(data) {
                    if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
                    return _fakeJsonResponse({ success: true, newTitle: data.weekTitle }, 200);
                }); });
        });
    },
    // Дашборд питания (вкладка "Админка" тренера) — сводка по ВСЕМ клиентам
    // тренера разом, не по одному. Форма ответа у нового API 1-в-1 совпадает
    // со старой ({stats, alerts, clients}) — реформатировать нечего. В
    // отличие от остального пилота, не завязан на конкретного клиента/
    // sheetName, поэтому резолвер имени не нужен.
    getFoodDashboard: function(nativeFetch) {
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/food-dashboard';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Ошибка' }, 200);
            return _fakeJsonResponse(res.data, 200);
        });
    },
    // Превью месячных отчётов — тоже сводка по всем клиентам разом, форма
    // ответа ({reports:[...]}) 1-в-1 совпадает со старой. Саму отправку
    // (sendMonthlyReportToClient) пилот не покрывает — уходит в старый
    // Apps Script как раньше (нужна интеграция с ботами, см. MIGRATION_PLAN.md).
    getMonthlyReportsPreview: function(nativeFetch) {
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/monthly-reports-preview';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Ошибка' }, 200);
            return _fakeJsonResponse(res.data, 200);
        });
    },
    // Аналог action=generateMealPlanAI — ИИ-генерация плана питания на день
    // (не сохраняет сама, фронт открывает редактор с результатом на правку).
    // Единственный ИИ-экшен мини-аппа в пилоте — остальной ИИ-анализ еды
    // клиента (фото/голос/текст) идёт через ботов напрямую, не через
    // fitness-app, поэтому вне периметра этого шима. Квота отдельная от
    // клиентского анализа еды (15/день на ТРЕНЕРА, не 5/день на клиента —
    // см. docstring generate_meal_plan_ai в api/main.py); ключ по clientName
    // (не chatId, как в теле POST у оригинала), поэтому нужен резолвер.
    generateMealPlanAI: function(nativeFetch, params, init) {
        var body;
        try { body = JSON.parse((init && init.body) || '{}'); } catch (_) { body = {}; }
        var clientName = body.clientName || '';
        return _resolveChatIdByName(nativeFetch, clientName).then(function(chatId) {
            if (!chatId) return _fakeJsonResponse({ success: false, error: 'Клиент не найден: ' + clientName }, 200);
            var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/meal-plan/generate';
            return nativeFetch(NEW_API_BASE + path, {
                method: 'POST', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    weight: body.weight || '', height: body.height || '', age: body.age || '',
                    goal: body.goal || '', allergies: body.allergies || ''
                })
            }).then(function(r) { return r.json().then(function(data) {
                // food_ai.generate_meal_plan уже отдаёт {success:false, error}
                // при провале ИИ (HTTP 200) — просто пробрасываем как есть.
                // Только не-2xx (429 квота, 404 клиент не найден) реформатируем.
                if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось' }, 200);
                return _fakeJsonResponse(data, 200);
            }); });
        });
    },
    // Аналог action=getAdminClients — главный экран "Тренерской", список
    // клиентов с цветными статусами по активности (не путать с getClients
    // — та отдаёт только chatId/name/archived для простых списков типа
    // резолвера имени). Форма ответа 1-в-1 совпадает со старой.
    getAdminClients: function(nativeFetch) {
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/admin-clients';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Ошибка' }, 200);
            return _fakeJsonResponse(res.data, 200);
        });
    },
    // Аналог action=saveExerciseMedia — фото/видео техники упражнения.
    // Поля тела запроса (name/group/video/videoVk/photo1Base64/photo1Mime/
    // photo2Base64/photo2Mime/removePhoto1/removePhoto2) уже совпадают с
    // новым бэкендом 1-в-1 (см. saveExerciseMediaEntry) — реформатировать
    // нечего, только вынести name в путь URL. В отличие от saveMeasurements
    // с фото, тут файловое хранилище на новом бэкенде УЖЕ есть (Railway
    // volume, см. MIGRATION_PLAN.md), поэтому честно перехватываем, а не
    // отдаём null.
    saveExerciseMedia: function(nativeFetch, params, init) {
        var body;
        try { body = JSON.parse((init && init.body) || '{}'); } catch (_) { body = {}; }
        var name = (body.name || '').trim();
        if (!name) return _fakeJsonResponse({ success: false, error: 'Не указано название упражнения' }, 200);
        var payload = {
            photo1Base64: body.photo1Base64 || null, photo1Mime: body.photo1Mime || 'image/jpeg',
            photo2Base64: body.photo2Base64 || null, photo2Mime: body.photo2Mime || 'image/jpeg',
            removePhoto1: !!body.removePhoto1, removePhoto2: !!body.removePhoto2,
            video: body.video, videoVk: body.videoVk, group: body.group
        };
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/exercises/' + encodeURIComponent(name) + '/media';
        return nativeFetch(NEW_API_BASE + path, {
            method: 'POST', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload)
        }).then(function(r) { return r.json().then(function(data) {
            if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось сохранить' }, 200);
            return _fakeJsonResponse(data, 200);
        }); });
    },
    // Аналог action=write/writeWorkoutData — клиент завершает тренировочный
    // день (кнопка «Сохранить» в тренировке). ВАЖНО: этот экшен идёт через
    // GET (см. save-btn обработчик — exercises кладутся в query string, не в
    // тело POST), поэтому читаем всё из params, не из init.body, как в
    // остальных write-шимах.
    //
    // Раньше в MIGRATION_PLAN.md этот экшен считался непереносимым — якобы
    // нужен опрос самочувствия (wn/fr2/fb/fr), которого нет на новом
    // бэкенде. Перепроверил апстрим (apps_script.js) — эти поля там тоже
    // нигде не сохраняются, чисто фронтендовая штука (корректирует
    // отображаемый план по самочувствию). Сохраняется только
    // rowIndex/weightFact/repsFact/comment — это уже умеет
    // POST .../program/complete-day.
    write: function(nativeFetch, params) {
        var chatId = params.get('chatId') || '';
        var raw = [];
        try { raw = JSON.parse(params.get('exercises') || '[]'); } catch (_) { raw = []; }
        var exercises = raw.map(function(ex) {
            return {
                exerciseId: parseInt(ex.r !== undefined ? ex.r : ex.rowIndex, 10),
                weightFact: (ex.w !== undefined ? ex.w : ex.weightFact) || '',
                repsFact: (ex.p !== undefined ? ex.p : ex.repsFact) || '',
                comment: (ex.c !== undefined ? ex.c : ex.comment) || ''
            };
        }).filter(function(e) { return !isNaN(e.exerciseId); });
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/program/complete-day';
        return nativeFetch(NEW_API_BASE + path, {
            method: 'POST', headers: _newApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ exercises: exercises })
        }).then(function(r) { return r.json().then(function(data) {
            if (!r.ok) return _fakeJsonResponse({ success: false, error: data.detail || 'Не удалось сохранить' }, 200);
            return _fakeJsonResponse({ success: true, saved: data.saved, timestamp: data.timestamp }, 200);
        }); });
    },
    // Аналог action=progress/getProgressStats — 3 плитки на клиентском
    // экране "Прогресс". Раньше числился заблокированным (нужен лист
    // "Архив", которого нет в новой БД) — при перепроверке оказалось, что
    // архив и не нужен: новый бэкенд считает по всем прошлым неделям
    // клиента на лету (они не перезатираются при переходе на новую неделю,
    // в отличие от старой системы). Форма ответа 1-в-1 совпадает со старой.
    progress: function(nativeFetch, params) {
        var chatId = params.get('chatId') || '';
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/clients/' + encodeURIComponent(chatId) + '/progress';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) return _fakeJsonResponse({ error: (res.data && res.data.detail) || 'Ошибка' }, 200);
            return _fakeJsonResponse(res.data, 200);
        });
    },
    // Аналог action=getTenantConfig — тема оформления, дёргается один раз
    // при старте мини-аппа. Не chatId-резолвинг (fallback на случай пустого
    // trainerId в ссылке) — тот путь и не задет этим шимом вообще, он
    // работает по CURRENT_TRAINER_ID, как и весь остальной пилот.
    // На 403 с blocked:true (доступ отключён/демо истекло) бэкенд отдаёт
    // detail ОБЪЕКТОМ {error, blocked}, не строкой, как везде — прокидываем
    // как есть, фронту (loadTenantConfig) нужен именно плоский blocked:true.
    getTenantConfig: function(nativeFetch) {
        var path = '/trainers/' + encodeURIComponent(_newApiTrainerId()) + '/tenant-config';
        return _newApiCall(nativeFetch, path).then(function(res) {
            if (!res.ok) {
                var d = res.data && res.data.detail;
                if (d && typeof d === 'object') return _fakeJsonResponse(d, 200);
                return _fakeJsonResponse({ error: d || 'Ошибка' }, 200);
            }
            return _fakeJsonResponse(res.data, 200);
        });
    }
};
NEW_API_ACTIONS.getExerciseMediaLibrary = NEW_API_ACTIONS.getExerciseLibrary;
var _PROFILE_KEYS = ['gender', 'age', 'height', 'weight', 'goal', 'level', 'frequency', 'limitations', 'inventory'];

(function() {
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
        var isAppsScript = typeof input === 'string' && input.indexOf(APPS_SCRIPT_URL) === 0;
        if (CURRENT_TRAINER_ID && isAppsScript) {
            // ВАЖНО: тут именно CURRENT_TRAINER_ID, не _newApiTrainerId() — это
            // трейлинг к запросу в СТАРЫЙ Apps Script, где для Matvey (тенант по
            // умолчанию) trainerId вообще не должен передаваться (см. комментарий
            // у _newApiTrainerId выше — иначе _resolveTenant('739299264') не
            // найдёт такую строку в реестре "Тренеры" и всё сломается).
            var sep = input.indexOf('?') === -1 ? '?' : '&';
            input = input + sep + 'trainerId=' + encodeURIComponent(CURRENT_TRAINER_ID);
        }
        if (isAppsScript) {
            if (_newApiTrainerId()) {
                var qIndex = input.indexOf('?');
                var params = new URLSearchParams(qIndex === -1 ? '' : input.slice(qIndex + 1));
                var handler = NEW_API_ACTIONS[params.get('action')];
                // handler может вернуть null (не Promise) — значит сам решил не
                // брать этот конкретный вызов (например saveMeasurements с фото:
                // загрузка в файловое хранилище на новом бэкенде пока не сделана,
                // честно не перехватываем, а не тихо теряем фото) — тогда падаем
                // в обычный старый путь ниже, как будто шима и не было.
                if (handler) {
                    var result = handler(nativeFetch, params, init);
                    if (result) return _withTimeout(result, 15000);
                }
            }
            return _fetchWithRetry(nativeFetch, input, init, 2);
        }
        return nativeFetch(input, init);
    };
})();

// Затемняет hex-цвет на заданную долю (0..1) — чтобы из ОДНОГО присланного
// тренером акцентного цвета получить вторую точку градиента, не требуя от
// тренера подбирать пару цветов вручную.
function _darkenHex(hex, amount) {
    try {
        var h = hex.replace('#', '');
        if (h.length === 3) h = h.split('').map(function(c) { return c + c; }).join('');
        var num = parseInt(h, 16);
        var r = Math.max(0, Math.round(((num >> 16) & 0xFF) * (1 - amount)));
        var g = Math.max(0, Math.round(((num >> 8) & 0xFF) * (1 - amount)));
        var b = Math.max(0, Math.round((num & 0xFF) * (1 - amount)));
        return '#' + [r, g, b].map(function(v) { return v.toString(16).padStart(2, '0'); }).join('');
    } catch (_) { return hex; }
}

function applyTenantTheme(theme) {
    if (!theme || !theme.primary) return;
    var root = document.documentElement;
    root.style.setProperty('--color-primary', theme.primary);
    root.style.setProperty('--color-primary-dark', _darkenHex(theme.primary, 0.2));
    if (theme.displayName) {
        var titleEl = document.querySelector('title');
        if (titleEl) titleEl.textContent = theme.displayName;
    }
}

// Возвращает false, если доступ тенанта заблокирован (демо истекло/отключён) —
// в этом случае сообщение уже показано и init() должен остановиться, ничего
// больше не загружая.
async function loadTenantConfig() {
    // Без vk_group_id в ссылке, но внутри VK (vkLaunchUserId есть) — всё
    // равно спрашиваем бэкенд: он найдёт тенанта по chatId сам (см. выше).
    // Только чистый Telegram-запуск пропускаем — там тенант всегда Matvey.
    if (!CURRENT_TRAINER_ID && !vkLaunchUserId) return true;
    try {
        var myChatId = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? String(tg.initDataUnsafe.user.id) : '';
        var url = APPS_SCRIPT_URL + '?action=getTenantConfig' +
            (myChatId ? '&chatId=' + encodeURIComponent(myChatId) : '');
        var resp = await fetch(url);
        var data = await resp.json();
        if (data && data.blocked) {
            document.body.innerHTML = '<div style="padding:40px 20px;text-align:center;font-family:sans-serif;">' +
                (data.error || 'Доступ недоступен') + '</div>';
            return false;
        }
        if (data && !data.error) {
            tenantTheme = data.theme || null;
            tenantTrainerChatId = data.trainerChatId || '';
            // Бэкенд мог сам разрулить тенанта по chatId, не по trainerId из
            // ссылки (которого у нас не было) — подхватываем узнанный id,
            // чтобы все дальнейшие запросы (через monkey-patch fetch выше)
            // тоже шли в правильную таблицу, а не только этот один.
            if (data.trainerId && data.trainerId !== 'default') {
                CURRENT_TRAINER_ID = data.trainerId;
            }
            applyTenantTheme(tenantTheme);
        }
    } catch (e) {
        console.error('loadTenantConfig failed:', e);
    }
    return true;
}

let tg;
let workoutData = [];
let completedCount = 0;
let totalExercises = 0;

// Платформа определяется по параметрам запуска: VK Mini Apps всегда добавляют
// vk_user_id в URL при открытии. Если его нет — считаем, что это Telegram
// (или обычный браузер для тестирования на десктопе, см. catch-фоллбэк ниже).
var vkLaunchUserId = new URLSearchParams(window.location.search).get('vk_user_id');

if (vkLaunchUserId) {
    try { window.vkBridge && window.vkBridge.send('VKWebAppInit'); } catch (_) {}
    tg = {
        initDataUnsafe: { user: { id: 'vk_' + vkLaunchUserId } },
        showAlert: function(msg) {
            try {
                window.vkBridge.send('VKWebAppShowSnackbar', { text: String(msg) }).catch(function() { alert(msg); });
            } catch (_) { alert(msg); }
        },
        showConfirm: function(msg, callback) {
            try {
                window.vkBridge.send('VKWebAppShowDialogBox', { title: '', text: String(msg) })
                    .then(function(data) { if (callback) callback(!!(data && data.result)); })
                    .catch(function() { if (callback) callback(confirm(msg)); });
            } catch (_) { if (callback) callback(confirm(msg)); }
        },
        HapticFeedback: {
            impactOccurred: function(style) {
                try { window.vkBridge.send('VKWebAppTapticImpactOccurred', { style: style || 'light' }); } catch (_) {}
            },
            notificationOccurred: function(type) {
                try { window.vkBridge.send('VKWebAppTapticNotificationOccurred', { type: type || 'success' }); } catch (_) {}
            }
        },
        openLink: function(url) {
            try {
                window.vkBridge.send('VKWebAppOpenLink', { link: url }).catch(function() { window.open(url, '_blank'); });
            } catch (_) { window.open(url, '_blank'); }
        },
        openTelegramLink: function(url) { window.open(url, '_blank'); },
        onEvent: function() {},
        ready: function() {},
        expand: function() {},
        isFullscreen: false,
        contentSafeAreaInset: { top: 0 }
    };
    document.documentElement.style.setProperty('--tg-top-pad', '0px');
    document.documentElement.style.setProperty('--vk-right-pad', '110px');
} else {
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
    // БЕЗ user.id здесь (раньше был захардкожен chatId Матвея) — см.
    // объяснение и единственное безопасное место для такого допущения в
    // _myChatId() ниже.
    tg = {
        initDataUnsafe: {},
        showAlert: (msg) => alert(msg),
        openLink: (url) => window.open(url, '_blank'),
        openTelegramLink: (url) => window.open(url, '_blank'),
        HapticFeedback: null
    };
}
}

// Единая точка получения chatId текущего пользователя — везде, где раньше
// каждое место само писало `tg.initDataUnsafe.user ? ... : '739299264'`
// (или TRAINER_CHAT_ID). Раньше это давало доступ ЛЮБОМУ, кто открыл ЛЮБУЮ
// ссылку мини-аппа не в Telegram/VK (обычный браузер) — chatId молча
// подставлялся как Матвея, а isTrainer()/isMatveySuperAdmin() сверяются
// именно с этим id, то есть случайный человек с demo-ссылкой получал
// полную супер-админку (найдено 2026-08-14 при подготовке демо-ссылки для
// Анны). Внутри настоящего Telegram/VK tg.initDataUnsafe.user всегда
// настоящий — туда фолбэк не попадает. Единственное место, где "предположить
// Матвея" оправдано — локальная разработка (localhost), это НЕ публичный
// домен, где ссылку может открыть кто угодно.
function _myChatId() {
    if (tg.initDataUnsafe && tg.initDataUnsafe.user) return String(tg.initDataUnsafe.user.id);
    var isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    return isLocalDev ? TRAINER_CHAT_ID : '';
}

// Единая безопасная обёртка над tg.showConfirm — раньше в 9 местах файла
// каждое место само проверяло tg.showConfirm && ..., но БЕЗ try/catch вокруг
// самого вызова. Если showConfirm бросает исключение (бывает на части
// Telegram-клиентов) или просто не вызывает колбэк — весь await зависал без
// единого сообщения об ошибке ("нажимаю кнопку — ноль реакции"). Теперь везде
// только через эту функцию, с откатом на нативный confirm() при любой проблеме.
function tgConfirm(message) {
    return new Promise(function(resolve) {
        try {
            if (tg && tg.showConfirm) {
                tg.showConfirm(message, function(ok) { resolve(!!ok); });
            } else {
                resolve(confirm(message));
            }
        } catch (e) {
            console.error('tgConfirm: showConfirm failed, falling back to native confirm', e);
            resolve(confirm(message));
        }
    });
}

document.addEventListener('DOMContentLoaded', init);

var clientName = '';
var weekTitle = '';

async function init() {
    console.log('Init started...');
    try {
        const tenantOk = await loadTenantConfig();
        if (!tenantOk) return;
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
        window.__appInitSettled = true; // см. сторожевой таймер в index.html — не перекрывать успешный экран
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('main-screen').classList.remove('hidden');
        initializeTabs();
        initAdminTab();
        initSuperAdminTab();
        // Опрос самочувствия — один раз при первом входе в тренировку.
        // Если клиент закроет/пропустит — считается «Бодрый», веса как есть.
        if (!wellnessAsked && workoutData.length > 0) {
            wellnessAsked = true;
            setTimeout(openWellnessModal, 400);
        }
    } catch (error) {
        console.error('ERROR:', error);
        // Любая ветка catch дальше сама покажет какой-то финальный экран
        // (админку, запрос доступа или текст ошибки) — сторожевой таймер в
        // index.html не должен затирать это своим общим "грузится долго",
        // если он сработает уже ПОСЛЕ того, как мы сами разобрались с ошибкой.
        window.__appInitSettled = true;
        // См. _myChatId() — вне Telegram/VK (обычный браузер) и не на
        // localhost currentChatId будет '', isTrainer('') = false, и код
        // ниже честно уйдёт в общий экран ошибки, а не притворится Матвеем.
        var currentChatId = _myChatId();
        if (/Client not found/.test(error.message) && isTrainer(currentChatId)) {
            // Тренер открыл свою же панель, но у него нет "своей" карточки клиента
            // (в отличие от Matvey, у которого в таблице есть тестовая запись о
            // себе — исторически) — это нормально. Ведём сразу в админку, а не на
            // экран "запросить доступ у тренера" (это же и есть тренер).
            document.getElementById('loading').classList.add('hidden');
            document.getElementById('main-screen').classList.remove('hidden');
            initializeTabs();
            initAdminTab();
        initSuperAdminTab();
            var adminTabBtn = document.querySelector('.tab-btn[data-tab="admin"]');
            if (adminTabBtn) adminTabBtn.click();
            return;
        }
        if (vkLaunchUserId && /Client not found/.test(error.message)) {
            renderVkAccessRequest();
            return;
        }
        document.getElementById('loading').innerHTML =
            '<div style="color: red; padding: 20px; text-align: center;">' +
            '<h3>Ошибка загрузки</h3>' +
            '<p>' + error.message + '</p>' +
            '<button onclick="location.reload()" style="padding: 10px 20px; margin-top: 10px;">Перезагрузить</button>' +
            '</div>';
    }
}

// Клиент открыл мини-апп во VK, но тренер ещё не выдал доступ (в VK нет
// бота-шлагбаума перед мини-аппом, как в Telegram, поэтому проверяем здесь).
function renderVkAccessRequest() {
    var chatId = tg.initDataUnsafe.user.id; // 'vk_<numeric id>'
    document.getElementById('loading').innerHTML =
        '<div style="padding: 24px; text-align: center;">' +
        '<h3>Доступа пока нет</h3>' +
        '<p>Тренер уже получил уведомление о твоей заявке. Если долго нет ответа — просто скажи ему этот код:</p>' +
        '<p style="font-size: 20px; font-weight: bold; margin: 12px 0;">' + chatId + '</p>' +
        '<button onclick="location.reload()" style="padding: 10px 20px; margin-top: 10px;">Проверить ещё раз</button>' +
        '</div>';

    function ping(name) {
        fetch(APPS_SCRIPT_URL + '?action=requestAccess&chatId=' + encodeURIComponent(chatId) + '&name=' + encodeURIComponent(name || '')).catch(function() {});
    }
    try {
        window.vkBridge.send('VKWebAppGetUserInfo').then(function(data) {
            ping(((data.first_name || '') + ' ' + (data.last_name || '')).trim());
        }).catch(function() { ping(''); });
    } catch (_) { ping(''); }
}
 
async function loadWorkoutData() {
    var chatId = _myChatId();
    var url = APPS_SCRIPT_URL + '?action=read&chatId=' + chatId;
    // Google Apps Script изредка отвечает разовым сбоем (HTTP 404/500 на
    // редиректе к googleusercontent.com) без видимой причины — само по себе
    // проходит при повторном запросе. Ретраим только СЕТЕВЫЕ/HTTP-сбои — не
    // трогаем осмысленные ответы бэкенда вида {error: "Client not found"},
    // их повтор не исправит, а только зря отложит нужный экран (админка/
    // запрос доступа).
    var lastErr;
    var maxAttempts = 4; // на практике наблюдали до 3 сбоев подряд — берём запас
    for (var attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            var response = await fetch(url);
            if (!response.ok) throw new Error('HTTP error ' + response.status);
            var data = await response.json();
            if (data.error) throw new Error(data.error);
            return data;
        } catch (e) {
            lastErr = e;
            if (!/^HTTP error/.test(e.message)) throw e;
            if (attempt < maxAttempts - 1) await new Promise(function(r) { setTimeout(r, 700); });
        }
    }
    throw lastErr;
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

        // Суперсеты/трисеты (см. groupExercises ниже — та же группировка, что
        // и в редакторе тренера) показываем клиенту сгруппированными, с общей
        // подписью, а не отдельными карточками с "Сет:"/"Трисет:" в названии.
        var groups = groupExercises(day.exercises || []);
        var flatIndex = 0;
        groups.forEach(function(group) {
            if (group.type === 'superset' || group.type === 'triset') {
                var wrap = document.createElement('div');
                wrap.className = 'exercise-group-block';
                var label = document.createElement('div');
                label.className = 'exercise-group-label';
                label.textContent = group.type === 'triset' ? '🔗 Трисет' : '🔗 Суперсет';
                wrap.appendChild(label);
                group.exercises.forEach(function(exercise) {
                    wrap.appendChild(createExerciseCard(exercise, dayIndex, flatIndex));
                    flatIndex++;
                });
                dayBody.appendChild(wrap);
            } else {
                dayBody.appendChild(createExerciseCard(group.exercises[0], dayIndex, flatIndex));
                flatIndex++;
            }
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
 
// Экранирование для вставки произвольной строки (ссылки) внутрь HTML-атрибута.
// Раньше ссылка на видео шла прямо в onclick="..." со «своим» экранированием
// под JS-строку — если в ссылке (скопированной из таблицы) оказывалась хоть
// одна двойная кавычка/перенос строки, вся кнопка молча ломалась.
function _escHtmlAttr(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function createExerciseCard(exercise, dayIndex, exIndex) {
    var card = document.createElement('div');
    card.className = 'exercise-card';
    var videoStr = exercise.video != null ? String(exercise.video).trim() : '';
    var videoVkStr = exercise.videoVk != null ? String(exercise.videoVk).trim() : '';
    var hasVideo = (videoStr && (videoStr.indexOf('http') !== -1 || videoStr.indexOf('📽️') !== -1)) ||
        (videoVkStr && videoVkStr.indexOf('http') !== -1);
    var photo1 = exercise.photo1 || '';
    var photo2 = exercise.photo2 || '';
    var photoHtml1 = photo1 ? '<img src="' + photo1 + '" alt="Photo 1" class="exercise-photo-img" onerror="this.parentElement.innerHTML=\'🏋️\'">' : '🏋️';
    var photoHtml2 = photo2 ? '<img src="' + photo2 + '" alt="Photo 2" class="exercise-photo-img" onerror="this.parentElement.innerHTML=\'💪\'">' : '💪';
    var noteHtml = exercise.note ? '<div class="trainer-note">💬 ' + exercise.note + '</div>' : '';
    var videoHtml = hasVideo ? '<button class="video-btn" data-video="' + _escHtmlAttr(videoStr) + '" data-video-vk="' + _escHtmlAttr(videoVkStr) + '" onclick="openVideo(this.dataset.video, this.dataset.videoVk)">📹 ВИДЕО ТЕХНИКИ</button>' : '';
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
            '<div class="exercise-name">' + cleanExerciseName(exercise.exercise) + '</div>' +
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
            var chatId = _myChatId();
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
 
function openVideo(url, urlVk) {
    // Во VK свои ссылки на видео (обычно vk.com/video...), т.к. t.me-ссылки
    // там не откроешь без Telegram. Если для упражнения такая ссылка ещё не
    // добавлена в таблицу — просто используем старую (Telegram) ссылку.
    var target = (vkLaunchUserId && urlVk) ? urlVk : url;
    if (!target || target === '📽️') {
        tg.showAlert('Ссылка на видео отсутствует');
        return;
    }
    if (target.indexOf('t.me') !== -1) {
        tg.openTelegramLink(target);
        return;
    }
    if (target.indexOf('http') === -1) {
        tg.showAlert('Неверный формат ссылки');
        return;
    }
    // Открываем обычной ссылкой напрямую, без мостовых API (VKWebAppOpenLink
    // иногда молча отказывает на ссылки vk.com, а запасной window.open после
    // такого отказа браузер блокирует как всплывающее окно вне клика).
    var a = document.createElement('a');
    a.href = target;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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

    // Заголовок недели — показываем как есть (например «Месяц 2 Неделя 3»)
    document.getElementById('home-week-num').textContent = (weekTitle || '—').toString();

    // Карточки по дням: только реальные тренировочные дни (с упражнениями).
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
        var status = '○'; // не начато
        if (total > 0 && done >= total) { dot.classList.add('full'); doneDays++; status = '✓'; }
        else if (done > 0) { dot.classList.add('partial'); status = '⏳'; }
        // Метка: первые 2 буквы названия дня без эмодзи
        var label = (day.day || '').toString()
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
            .trim().substring(0, 2);
        dot.title = day.day + ': ' + done + '/' + total;
        dot.innerHTML = '<span class="home-dot-day">' + (label || '?') + '</span>' +
                        '<span class="home-dot-status">' + status + '</span>';
        dotsContainer.appendChild(dot);
    });

    document.getElementById('home-week-summary').textContent =
        doneDays + ' из ' + trainingDays.length + ' дней выполнено';
}

// Подгружает рекорды и текущий вес для карточек на главной — асинхронно, не блокирует UI
async function loadHomeExtras() {
    var chatId = _myChatId();
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
        var chatId = _myChatId();
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

    // ── Специфические упражнения с уникальными названиями (проверяем первыми,
    //    чтобы общие шаблоны не перехватили их в неправильную группу) ──
    if (/румынск/i.test(name)) return 'Ноги';        // румынская тяга — задняя поверхность бедра
    if (/мёртв|мертв/i.test(name)) return 'Ноги';    // мёртвая тяга
    if (/гиперэкс|гипер\s*экс|hyper/i.test(name)) return 'Спина';
    if (/колодец|пек.*дек|peck.*deck/i.test(name)) return 'Спина';
    if (/франц/i.test(name)) return 'Трицепс';       // французский жим
    if (/калифорний/i.test(name)) return 'Трицепс';  // калифорнийский жим
    if (/гудмор|good\s*morning|накл[оё]н\s*со\s*штангой/i.test(name)) return 'Ноги';

    // Грудь
    if (/жим.*(л[её]ж|горизонт|наклон|смит|гильот|крс|кроссовер|жим.*узк|узк\w*\s*хват)|разводк|кроссовер|сведен.*рук|бабочка|отжим|жим.*верх\s*груд|жим.*низ\s*груд|жим.*гантел|жим.*штанг.*груд/i.test(name)) return 'Грудь';
    // Ноги (проверяем РАНЬШЕ Спины — чтобы «отведение/приведение ног», «выпад» и т.д. не уходили в спину)
    if (/присед|жим.*платформ|жим.*ног|выпад|разгиб.*ног|сгиб.*ног|икр|голен|гак|станов|отведен.*ног|приведен.*ног|ягодиц|махи.*ног|болгарск|sissy/i.test(name)) return 'Ноги';
    // Спина
    if (/тяг.*(верхн|нижн|горизонт|блок|штанг|гантел|канат|узк|шир|т-?гриф|сумо|становая)|подтяг|пуловер|рычаж|шраг/i.test(name)) return 'Спина';
    // Плечи
    if (/жим.*(сид|стоя|арнольд|плеч|штанг.*стоя)|мах|тяг.*подбородк|разводк.*стоя|дельт|протяжк|шраги.*стоя/i.test(name)) return 'Плечи';
    // Бицепс
    if (/бицепс|сгиб.*рук|молот|концентр|скотт/i.test(name)) return 'Бицепс';
    // Трицепс
    if (/трицепс|разгиб.*(рук|канат|гантел|штанг|из.*голов|на\s*блоке|на\s*трицепс)|жим.*узк|отжим.*брус|кикбэк|kickback/i.test(name)) return 'Трицепс';
    // Пресс
    if (/пресс|скруч|подъ[её]м.*ног|планк|вакуум|велосипед/i.test(name)) return 'Пресс';
    return 'Другое';
}

async function loadExerciseHistory() {
    try {
        var chatId = _myChatId();
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
    var chatId = _myChatId();
    if (isTrainer(chatId)) {
        document.getElementById('admin-tab-btn').classList.remove('hidden');
        document.getElementById('tabs-container').classList.add('tabs-5');
        initFilters();
        initAdminClientsControls();
        initAdminSectionTabs();
        initClientCardTabs();
        initExerciseEditor();
        initAddTypeDialog();
        initBlockModal();
        initNewClientPlatformToggle();
        initExerciseMediaLibrary();
    }
}

// Переключатель VK / Telegram в форме нового клиента — меняет подпись, плейсхолдер
// и подсказку под полем chat_id в зависимости от выбранной платформы.
function _updateNcChatIdLabel() {
    var platform = _ncSelectedPlatform();
    var label = document.getElementById('nc-chatid-label');
    var hint = document.getElementById('nc-chatid-hint');
    var input = document.getElementById('nc-chatid');
    if (!label || !hint || !input) return;
    if (platform === 'telegram') {
        label.textContent = 'Telegram chat_id *';
        input.placeholder = '739299264';
        hint.textContent = 'Спроси у клиента — он узнает через @userinfobot в Telegram';
    } else {
        label.textContent = 'ID клиента ВКонтакте *';
        input.placeholder = '123456789';
        hint.textContent = 'Из ссылки на профиль: vk.com/id123456789 → 123456789. Если у клиента короткое имя (vk.com/ivan_petrov) — попроси переслать в сообщения группы любое сообщение, id придёт в уведомлении.';
    }
}

function _ncSelectedPlatform() {
    var checked = document.querySelector('input[name="nc-platform"]:checked');
    return checked ? checked.value : 'vk';
}

function initNewClientPlatformToggle() {
    document.querySelectorAll('input[name="nc-platform"]').forEach(function(el) {
        el.addEventListener('change', _updateNcChatIdLabel);
    });
}

// Супер-админка — список ВСЕХ тренеров (не только текущего тенанта). Видна
// только буквально Matvey (хардкод TRAINER_CHAT_ID/TRAINER_VK_CHAT_ID), а не
// tenantTrainerChatId — иначе тренер, тестирующий своё демо, тоже бы её увидел.
var SUPERADMIN_STATUS_LABELS = { active: 'Активен', demo: 'Демо', disabled: 'Отключён' };

function isMatveySuperAdmin(chatId) {
    return chatId === TRAINER_CHAT_ID || chatId === TRAINER_VK_CHAT_ID;
}

function initSuperAdminTab() {
    var chatId = _myChatId();
    if (!isMatveySuperAdmin(chatId)) return;
    document.getElementById('superadmin-tab-btn').classList.remove('hidden');
    var tabsContainer = document.getElementById('tabs-container');
    tabsContainer.classList.remove('tabs-5');
    tabsContainer.classList.add('tabs-6');
    loadSuperAdminTrainers();

    // Открыт чужой тенант (?vk_group_id=...) — показываем баннер, чтобы не
    // перепутать, чью админку сейчас видно.
    if (CURRENT_TRAINER_ID) {
        document.getElementById('superadmin-view-id').textContent = CURRENT_TRAINER_ID;
        document.getElementById('superadmin-view-banner').classList.remove('hidden');
    }
}

function exitTrainerView() {
    window.location.search = '';
}

var SUPERADMIN_PAYMENT_LABELS = {
    active: 'Оплачено', expiring_week: 'Истекает <7д', expiring_soon: 'Истекает <3д', expired: 'Не оплачено'
};

async function loadSuperAdminTrainers() {
    var chatId = _myChatId();
    var container = document.getElementById('superadmin-trainers-list');
    try {
        var resp = await fetch(APPS_SCRIPT_URL + '?action=getTrainersOverview&chatId=' + encodeURIComponent(chatId));
        var data = await resp.json();
        if (data.error) {
            container.innerHTML = '<div class="no-data">Ошибка: ' + data.error + '</div>';
            return;
        }
        var trainers = data.trainers || [];
        try {
            var payResp = await fetch(APPS_SCRIPT_URL + '?action=getTrainerPayments&chatId=' + encodeURIComponent(chatId));
            var payData = await payResp.json();
            var payMap = {};
            (payData.payments || []).forEach(function(p) { payMap[p.trainerId] = p; });
            trainers.forEach(function(t) { t.payment = payMap[t.trainerId] || null; });
        } catch (_) {} // статус оплаты необязателен — список тренеров важнее
        renderSuperAdminTrainers(trainers);
    } catch (e) {
        container.innerHTML = '<div class="no-data">Не удалось загрузить</div>';
    }
}

function renderSuperAdminTrainers(trainers) {
    var container = document.getElementById('superadmin-trainers-list');
    if (!trainers.length) {
        container.innerHTML = '<div class="no-data">Тренеров пока нет</div>';
        return;
    }
    container.innerHTML = trainers.map(function(t) {
        var statusLabel = SUPERADMIN_STATUS_LABELS[t.status] || t.status || '—';
        var isDisabled = t.status === 'disabled';
        var expiresLine = t.demoExpiresAt
            ? ('<div class="superadmin-trainer-meta">Демо до: ' + new Date(t.demoExpiresAt).toLocaleString('ru-RU') + '</div>')
            : '';
        var name = (t.displayName || t.trainerId || '').toString();
        var sheetLink = t.spreadsheetId
            ? ('<a class="superadmin-sheet-link" href="https://docs.google.com/spreadsheets/d/' + t.spreadsheetId + '" target="_blank" onclick="event.stopPropagation()">📊 Таблица</a>')
            : '';
        var openAsBtn = t.vkGroupId
            ? ('<button class="superadmin-openas-btn" onclick="openAsTrainer(\'' + t.vkGroupId + '\')">🔎 Открыть как тренер</button>')
            : '';
        var p = t.payment;
        var paymentLabel = p ? (SUPERADMIN_PAYMENT_LABELS[p.status] || p.status) : 'Нет оплат';
        var paymentClass = p ? p.status : 'expired';
        var paymentMeta = p ? (' · до ' + p.endDate + ' (' + p.daysLeft + ' дн.)') : '';
        return (
            '<div class="superadmin-trainer-row">' +
                '<div class="superadmin-trainer-info">' +
                    '<div class="superadmin-trainer-name">' + name + '</div>' +
                    '<div class="superadmin-trainer-meta">ID: ' + t.trainerId +
                        (t.vkGroupId ? (' · группа ' + t.vkGroupId) : '') + '</div>' +
                    expiresLine +
                    '<span class="superadmin-status-badge status-' + (t.status || '') + '">' + statusLabel + '</span>' +
                    '<span class="superadmin-status-badge payment-' + paymentClass + '">💰 ' + paymentLabel + paymentMeta + '</span>' +
                    sheetLink + openAsBtn +
                '</div>' +
                '<div class="superadmin-trainer-actions">' +
                    '<button class="superadmin-pay-btn" onclick="openTrainerPaymentModal(\'' + t.trainerId + '\', \'' + name.replace(/'/g, "\\'") + '\')">💰 Оплата</button>' +
                    '<button class="superadmin-toggle-btn' + (isDisabled ? ' is-disabled' : '') +
                        '" onclick="toggleTrainerStatus(\'' + t.trainerId + '\', \'' + (isDisabled ? 'active' : 'disabled') + '\')">' +
                        (isDisabled ? 'Включить' : 'Отключить') +
                    '</button>' +
                '</div>' +
            '</div>'
        );
    }).join('');
}

var currentPaymentTrainer = null;

function openTrainerPaymentModal(trainerId, displayName) {
    currentPaymentTrainer = { trainerId: trainerId, name: displayName };
    document.getElementById('trainer-payment-modal-title').textContent = '💰 Оплата — ' + displayName;
    document.getElementById('tp-amount').value = '';
    document.getElementById('tp-months').value = '1';
    document.getElementById('tp-comment').value = '';
    var btn = document.getElementById('tp-save-btn');
    btn.disabled = false;
    btn.textContent = '💾 Записать';
    document.getElementById('trainer-payment-modal').classList.remove('hidden');
}

function closeTrainerPaymentModal() {
    document.getElementById('trainer-payment-modal').classList.add('hidden');
    currentPaymentTrainer = null;
}

async function saveTrainerPaymentFromModal() {
    if (!currentPaymentTrainer) return;
    var amount = parseFloat(document.getElementById('tp-amount').value);
    var months = parseInt(document.getElementById('tp-months').value);
    var comment = document.getElementById('tp-comment').value.trim();
    if (!amount || amount <= 0) { tg.showAlert('Укажи сумму больше 0'); return; }
    if (!months || months <= 0) { tg.showAlert('Укажи кол-во месяцев больше 0'); return; }
    var chatId = _myChatId();
    var btn = document.getElementById('tp-save-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Сохранение...';
    try {
        var url = APPS_SCRIPT_URL + '?action=saveTrainerPayment' +
            '&chatId=' + encodeURIComponent(chatId) +
            '&targetTrainerId=' + encodeURIComponent(currentPaymentTrainer.trainerId) +
            '&amount=' + encodeURIComponent(amount) +
            '&months=' + encodeURIComponent(months) +
            '&comment=' + encodeURIComponent(comment);
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            btn.disabled = false;
            btn.textContent = '💾 Записать';
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        closeTrainerPaymentModal();
        loadSuperAdminTrainers();
    } catch (e) {
        tg.showAlert('Ошибка соединения ❌');
        btn.disabled = false;
        btn.textContent = '💾 Записать';
    }
}

// Открыть мини-апп «от лица» тренера — vk_group_id уже подхватывается всей
// остальной логикой мульти-тенантности сам по себе (см. CURRENT_TRAINER_ID,
// isTrainer() в начале файла), отдельный бэкенд-эндпоинт не нужен.
function openAsTrainer(vkGroupId) {
    window.location.search = '?vk_group_id=' + encodeURIComponent(vkGroupId);
}

function openNewTrainerForm() {
    document.getElementById('nt-name').value = '';
    document.getElementById('nt-vkgroup').value = '';
    document.getElementById('nt-chatid').value = '';
    document.getElementById('nt-demo-chatid').value = '';
    document.getElementById('nt-color').value = '';
    document.getElementById('nt-vktoken').value = '';
    document.getElementById('nt-status').value = 'demo';
    updateNewTrainerFormMode();
    document.getElementById('new-trainer-modal').classList.remove('hidden');
    document.body.classList.add('no-scroll');
}

function closeNewTrainerForm() {
    document.getElementById('new-trainer-modal').classList.add('hidden');
    document.body.classList.remove('no-scroll');
}

// Демо — имя + необязательный VK ID зрителя (см. submitNewTrainer: демо
// уходит через action=createDemoTrainer, не createTrainer — VK-группа/токен
// не нужны вообще, готовая ссылка появляется в списке тренеров сразу после
// создания). Боевой — как раньше, все поля.
//
// VK ID зрителя (2026-08-14) — без него ссылку сможет открыть кто угодно в
// обычном браузере, но НЕ увидит панель тренера: раньше "работало" только
// из-за дыры в безопасности (обычный браузер притворялся Матвеем, см.
// _myChatId()) — теперь дыра закрыта, и без настоящего VK ID зрителя
// демо-ссылка никого не узнает.
function updateNewTrainerFormMode() {
    var isDemo = document.getElementById('nt-status').value === 'demo';
    document.getElementById('nt-demo-fields').classList.toggle('hidden', !isDemo);
    document.getElementById('nt-active-fields').classList.toggle('hidden', isDemo);
    document.getElementById('nt-mode-hint').textContent = isDemo
        ? 'Таблица под тренера создастся автоматически (копия шаблона с демо-клиентами), доступ сгорит через 48 часов сам. Ссылку — из списка тренеров, кнопка «Открыть как тренер».'
        : 'Таблица под тренера создастся автоматически, пустая — без твоих клиентов и упражнений. Тренер заведёт всё своё сам.';
}

async function submitNewTrainer() {
    var name = document.getElementById('nt-name').value.trim();
    if (!name) { tg.showAlert('Укажи имя тренера'); return; }
    var status = document.getElementById('nt-status').value;
    var myChatId = _myChatId();

    var btn = document.getElementById('nt-create-btn');
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Создание...';

    try {
        var data;
        if (status === 'demo') {
            // Демо: имя + необязательный VK ID зрителя, ссылку показываем
            // сразу — не нужно ждать, пока тренер сам её найдёт в списке.
            // trainerChatId (2026-08-14): раньше нарочно не передавали — но
            // это опиралось на дыру в безопасности (обычный браузер
            // притворялся Матвеем, см. _myChatId()), дыра закрыта, и без
            // настоящего VK ID зрителя демо-ссылка теперь никого не узнает.
            var demoChatIdRaw = document.getElementById('nt-demo-chatid').value.trim();
            var demoTrainerChatId = demoChatIdRaw ? ('vk_' + demoChatIdRaw.replace(/\D/g, '')) : '';
            var demoQs = 'action=createDemoTrainer&chatId=' + encodeURIComponent(myChatId) +
                '&displayName=' + encodeURIComponent(name) +
                '&trainerChatId=' + encodeURIComponent(demoTrainerChatId) +
                '&demoHours=48';
            var demoResp = await fetch(APPS_SCRIPT_URL + '?' + demoQs);
            data = await demoResp.json();
            if (!data.success) {
                tg.showAlert('Ошибка: ' + (data.error || 'не удалось создать демо'));
                btn.disabled = false;
                btn.textContent = origText;
                return;
            }
            if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
            closeNewTrainerForm();
            btn.disabled = false;
            btn.textContent = origText;
            await loadSuperAdminTrainers();
            var link = window.location.origin + window.location.pathname + '?vk_group_id=' + encodeURIComponent(data.trainerId);
            var noViewerWarning = demoTrainerChatId ? '' :
                '\n\n⚠️ VK ID зрителя не указан — по этой ссылке никто не увидит панель тренера. Добавь VK ID и создай демо заново, либо укажи его позже прямо в таблице.';
            tg.showAlert('✅ Демо готово на 48 часов.\n\nСсылка:\n' + link + noViewerWarning);
        } else {
            var vkGroupId = document.getElementById('nt-vkgroup').value.trim();
            if (!vkGroupId || !/^\d+$/.test(vkGroupId)) {
                tg.showAlert('Укажи ID VK-группы (число)');
                btn.disabled = false;
                btn.textContent = origText;
                return;
            }
            var chatIdRaw = document.getElementById('nt-chatid').value.trim();
            var trainerChatId = chatIdRaw ? ('vk_' + chatIdRaw.replace(/\D/g, '')) : '';
            var color = document.getElementById('nt-color').value.trim();
            var vkToken = document.getElementById('nt-vktoken').value.trim();
            var qs = 'action=createTrainer&chatId=' + encodeURIComponent(myChatId) +
                '&displayName=' + encodeURIComponent(name) +
                '&vkGroupId=' + encodeURIComponent(vkGroupId) +
                '&trainerChatId=' + encodeURIComponent(trainerChatId) +
                '&themePrimary=' + encodeURIComponent(color) +
                '&vkToken=' + encodeURIComponent(vkToken) +
                '&status=active';
            var resp = await fetch(APPS_SCRIPT_URL + '?' + qs);
            data = await resp.json();
            if (!data.success) {
                tg.showAlert('Ошибка: ' + (data.error || 'не удалось создать'));
                btn.disabled = false;
                btn.textContent = origText;
                return;
            }
            if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
            closeNewTrainerForm();
            btn.disabled = false;
            btn.textContent = origText;
            await loadSuperAdminTrainers();
            tg.showAlert('✅ Тренер создан. Пустая таблица тоже готова — ссылка есть в списке.');
        }
    } catch (e) {
        console.error('submitNewTrainer error:', e);
        tg.showAlert('Ошибка соединения ❌');
        btn.disabled = false;
        btn.textContent = origText;
    }
}

async function toggleTrainerStatus(trainerId, newStatus) {
    var chatId = _myChatId();
    try {
        var resp = await fetch(APPS_SCRIPT_URL + '?action=setTrainerStatus&chatId=' + encodeURIComponent(chatId) +
            '&targetTrainerId=' + encodeURIComponent(trainerId) + '&status=' + encodeURIComponent(newStatus));
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Не получилось: ' + (data.error || 'ошибка'));
            return;
        }
        loadSuperAdminTrainers();
    } catch (e) {
        tg.showAlert('Ошибка сети');
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
        var foodLogBtn = client.chatId ? '<button class="food-log-btn" data-chat-id="' + _escHtmlAttr(client.chatId) + '" data-name="' + _escHtmlAttr(client.name || '') + '" onclick="openFoodLogModal(this.dataset.chatId, this.dataset.name)">📋 Питание по дням</button>' : '';

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
            '<div class="client-card-actions">' + foodLogBtn + msgBtn + '</div>' +
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

// Дриллдаун из дашборда питания: что именно клиент ел по дням, а не только
// суммарные цифры за сегодня.
var FOOD_VERDICT_EMOJI = { excellent: '⭐⭐⭐⭐⭐', good: '⭐⭐⭐⭐', acceptable: '⭐⭐⭐', needs_adjustment: '⭐⭐', poor: '⭐' };

async function openFoodLogModal(chatId, name) {
    document.getElementById('food-log-title').textContent = '📋 Питание — ' + (name || 'Клиент');
    var body = document.getElementById('food-log-body');
    body.innerHTML = '<div class="no-data">Загрузка...</div>';
    document.getElementById('food-log-modal').classList.remove('hidden');
    try {
        var url = APPS_SCRIPT_URL + '?action=getClientFoodEntries&chatId=' + encodeURIComponent(chatId) + '&days=14';
        var resp = await fetch(url);
        var data = await resp.json();
        if (data.error) {
            body.innerHTML = '<div class="no-data">' + data.error + '</div>';
            return;
        }
        if (!data.days || data.days.length === 0) {
            body.innerHTML = '<div class="no-data">Нет записей питания за последние 14 дней</div>';
            return;
        }
        body.innerHTML = data.days.map(function(day) {
            var entriesHtml = day.entries.map(function(e) {
                var noteHtml = e.note ? '<div class="food-log-note">' + e.note + '</div>' : '';
                return '<div class="food-log-entry">' +
                    '<div class="food-log-entry-head">' +
                        '<span class="food-log-time">' + (e.time || '') + '</span>' +
                        '<span>' + (e.mealType || '') + '</span>' +
                        '<span>' + (FOOD_VERDICT_EMOJI[e.verdict] || '') + '</span>' +
                    '</div>' +
                    '<div class="food-log-macros">' +
                        Math.round(e.calories) + ' ккал · Б' + Math.round(e.protein) + ' · Ж' + Math.round(e.fats) + ' · У' + Math.round(e.carbs) +
                    '</div>' +
                    noteHtml +
                '</div>';
            }).join('');
            return '<div class="food-log-day">' +
                '<div class="food-log-day-header">' +
                    '<span>' + day.date + '</span>' +
                    '<span>' + Math.round(day.totals.calories) + ' ккал · Б' + Math.round(day.totals.protein) + ' Ж' + Math.round(day.totals.fats) + ' У' + Math.round(day.totals.carbs) + '</span>' +
                '</div>' +
                entriesHtml +
            '</div>';
        }).join('');
    } catch (error) {
        console.error('Food log error:', error);
        body.innerHTML = '<div class="no-data">Ошибка загрузки</div>';
    }
}

function closeFoodLogModal() {
    document.getElementById('food-log-modal').classList.add('hidden');
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

// ========== ПЕРЕКЛЮЧАТЕЛЬ КЛИЕНТЫ / ФИНАНСЫ ==========

function switchAdminSection(sectionName) {
    document.querySelectorAll('.admin-section-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.adminSection === sectionName);
    });
    document.querySelectorAll('.admin-section').forEach(function(s) {
        s.classList.remove('active');
    });
    var target = document.getElementById('admin-section-' + sectionName);
    if (target) target.classList.add('active');
    if (sectionName === 'finances') loadFinances();
    if (sectionName === 'reports') loadMonthlyReports();
    if (sectionName === 'exercises') loadExerciseMediaLibrary();
}

function initAdminSectionTabs() {
    document.querySelectorAll('.admin-section-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            switchAdminSection(btn.dataset.adminSection);
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
        });
    });
}

// ========== БИБЛИОТЕКА УПРАЖНЕНИЙ (фото/видео техники, тренер сам загружает) ==========

var exerciseMediaData = []; // последний загруженный список из getExerciseMediaLibrary
var exerciseMediaEditingName = ''; // название упражнения, которое сейчас редактируется ('' — новое)
var exerciseMediaPending = {}; // { photo1Base64, photo1Mime, photo2Base64, photo2Mime, removePhoto1, removePhoto2 } — накапливается до сохранения
var exerciseMediaSelectedGroup = ''; // выбранная группа мышц в редакторе (см. openExerciseMediaEditor/_renderExerciseMediaGroupTabs)
// Тот же список, что и KNOWN_MUSCLES (см. ниже, для фильтра библиотеки при
// подборе упражнения клиенту) — держим отдельной переменной здесь, чтобы не
// зависеть от порядка объявления в файле.
var EXERCISE_MEDIA_GROUPS = ['Грудь', 'Спина', 'Плечи', 'Бицепс', 'Трицепс', 'Ноги', 'Ягодицы', 'Пресс', 'Икры', 'Предплечья'];

function initExerciseMediaLibrary() {
    var search = document.getElementById('ex-media-search');
    if (search) search.addEventListener('input', function() {
        renderExerciseMediaList(search.value.trim().toLowerCase());
    });
    ['1', '2'].forEach(function(slot) {
        var fileInput = document.getElementById('ex-media-photo' + slot + '-file');
        var clearBtn = document.getElementById('ex-media-photo' + slot + '-clear');
        if (fileInput) fileInput.addEventListener('change', function() {
            var file = fileInput.files && fileInput.files[0];
            if (!file) return;
            _compressImageFile(file, 1280, 0.82, function(result) {
                exerciseMediaPending['photo' + slot + 'Base64'] = result.base64;
                exerciseMediaPending['photo' + slot + 'Mime'] = result.mime;
                exerciseMediaPending['removePhoto' + slot] = false;
                var preview = document.getElementById('ex-media-photo' + slot + '-preview');
                if (preview) preview.innerHTML = '<img src="data:' + result.mime + ';base64,' + result.base64 + '">';
            }, function(errMsg) {
                fileInput.value = '';
                tg.showAlert('❌ ' + errMsg);
            });
        });
        if (clearBtn) clearBtn.addEventListener('click', function() {
            exerciseMediaPending['photo' + slot + 'Base64'] = '';
            exerciseMediaPending['removePhoto' + slot] = true;
            if (fileInput) fileInput.value = '';
            var preview = document.getElementById('ex-media-photo' + slot + '-preview');
            if (preview) preview.innerHTML = slot === '1' ? '🏋️' : '💪';
        });
    });
}

async function loadExerciseMediaLibrary() {
    var list = document.getElementById('ex-media-list');
    try {
        var resp = await fetch(APPS_SCRIPT_URL + '?action=getExerciseMediaLibrary');
        var data = await resp.json();
        exerciseMediaData = data.exercises || [];
        renderExerciseMediaList(document.getElementById('ex-media-search') ? document.getElementById('ex-media-search').value.trim().toLowerCase() : '');
    } catch (e) {
        console.error('loadExerciseMediaLibrary failed:', e);
        if (list) list.innerHTML = '<div class="no-data">Не удалось загрузить ❌</div>';
    }
}

function renderExerciseMediaList(filter) {
    var list = document.getElementById('ex-media-list');
    if (!list) return;
    var items = exerciseMediaData.filter(function(ex) {
        return !filter || ex.name.toLowerCase().indexOf(filter) !== -1;
    });
    if (!items.length) {
        list.innerHTML = '<div class="no-data">' + (filter ? 'Ничего не найдено' : 'Упражнений пока нет — добавь первое') + '</div>';
        return;
    }
    list.innerHTML = items.map(function(ex) {
        var thumb1 = ex.photo1 ? '<img src="' + ex.photo1 + '">' : '🏋️';
        var thumb2 = ex.photo2 ? '<img src="' + ex.photo2 + '">' : '💪';
        var hasVideo = !!(ex.video || ex.videoVk);
        return '<div class="ex-media-item" onclick="openExerciseMediaEditor(\'' + ex.name.replace(/'/g, "\\'") + '\')">' +
            '<div class="ex-media-thumbs">' +
                '<div class="ex-media-thumb">' + thumb1 + '</div>' +
                '<div class="ex-media-thumb">' + thumb2 + '</div>' +
            '</div>' +
            '<div class="ex-media-info">' +
                '<div class="ex-media-name">' + ex.name + '</div>' +
                '<div class="ex-media-badges">' +
                    (ex.group ? '<span class="ex-media-badge filled">' + ex.group + '</span>' : '') +
                    '<span class="ex-media-badge ' + (ex.photo1 && ex.photo2 ? 'filled' : '') + '">📷 фото</span>' +
                    '<span class="ex-media-badge ' + (hasVideo ? 'filled' : '') + '">🎬 видео</span>' +
                '</div>' +
            '</div>' +
            '<div class="ex-media-edit-icon">✏️</div>' +
        '</div>';
    }).join('');
}

// Рисует чипы групп мышц в редакторе упражнения — переключение как в
// ex-lib-tab (одиночный выбор), см. exerciseMediaSelectedGroup.
function _renderExerciseMediaGroupTabs(selected) {
    exerciseMediaSelectedGroup = selected || '';
    var box = document.getElementById('ex-media-group-tabs');
    if (!box) return;
    box.innerHTML = EXERCISE_MEDIA_GROUPS.map(function(g) {
        var active = g === exerciseMediaSelectedGroup ? ' active' : '';
        return '<button type="button" class="ex-lib-tab' + active + '" data-group="' + g + '">' + g + '</button>';
    }).join('');
    box.querySelectorAll('.ex-lib-tab').forEach(function(btn) {
        btn.addEventListener('click', function() {
            // Повторный клик по уже выбранной группе — снимает выбор (не обязательно).
            exerciseMediaSelectedGroup = (btn.dataset.group === exerciseMediaSelectedGroup) ? '' : btn.dataset.group;
            box.querySelectorAll('.ex-lib-tab').forEach(function(b) {
                b.classList.toggle('active', b.dataset.group === exerciseMediaSelectedGroup);
            });
        });
    });
}

function openExerciseMediaEditor(name) {
    exerciseMediaEditingName = name || '';
    exerciseMediaPending = {};
    var ex = name ? exerciseMediaData.find(function(e) { return e.name === name; }) : null;

    document.getElementById('ex-media-title').textContent = name ? 'Упражнение' : 'Новое упражнение';
    var nameInput = document.getElementById('ex-media-name');
    nameInput.value = ex ? ex.name : '';
    nameInput.disabled = !!ex; // у существующего упражнения название не трогаем (иначе потеряется связь со старой записью)

    _renderExerciseMediaGroupTabs(ex ? (ex.group || '') : '');

    document.getElementById('ex-media-video').value = ex ? (ex.video || '') : '';
    document.getElementById('ex-media-video-vk').value = ex ? (ex.videoVk || '') : '';

    ['1', '2'].forEach(function(slot) {
        var fileInput = document.getElementById('ex-media-photo' + slot + '-file');
        if (fileInput) fileInput.value = '';
        var preview = document.getElementById('ex-media-photo' + slot + '-preview');
        var url = ex ? ex['photo' + slot] : '';
        if (preview) preview.innerHTML = url ? '<img src="' + url + '">' : (slot === '1' ? '🏋️' : '💪');
    });

    document.getElementById('ex-media-modal').classList.remove('hidden');
    document.body.classList.add('no-scroll');
}

function closeExerciseMediaEditor() {
    document.getElementById('ex-media-modal').classList.add('hidden');
    document.body.classList.remove('no-scroll');
}

async function saveExerciseMediaEntry() {
    var name = (document.getElementById('ex-media-name').value || '').trim();
    if (!name) { tg.showAlert('Укажи название упражнения'); return; }

    var btn = document.getElementById('ex-media-save-btn');
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Сохранение...';

    var payload = Object.assign({
        name: name,
        group: exerciseMediaSelectedGroup,
        video: document.getElementById('ex-media-video').value.trim(),
        videoVk: document.getElementById('ex-media-video-vk').value.trim()
    }, exerciseMediaPending);

    try {
        var resp = await fetch(APPS_SCRIPT_URL + '?action=saveExerciseMedia', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось сохранить'));
            btn.disabled = false;
            btn.textContent = origText;
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        closeExerciseMediaEditor();
        btn.disabled = false;
        btn.textContent = origText;
        await loadExerciseMediaLibrary();
        tg.showAlert('✅ Сохранено');
    } catch (e) {
        console.error('saveExerciseMediaEntry error:', e);
        tg.showAlert('Ошибка соединения ❌');
        btn.disabled = false;
        btn.textContent = origText;
    }
}

// Сжимает фото в браузере перед отправкой (иначе фото с телефона по 5-10 МБ
// будут долго улетать и быстро съедят место в Google Drive). Возвращает через
// callback { base64, mime } — без префикса "data:...;base64,".
// onError — необязательный колбэк, вызывается при сбое (например, HEIC-фото
// с iPhone, которое браузер не может отрисовать через <img>/canvas — тогда
// img.onload молча никогда не срабатывает). Раньше без onError сбой был
// полностью незаметен: файл просто не попадал в форму, а трener видел
// "клиент не прикладывал фото", хотя клиент был уверен, что прикрепил.
function _compressImageFile(file, maxDim, quality, callback, onError) {
    var img = new Image();
    var reader = new FileReader();
    reader.onerror = function() {
        if (onError) onError('Не удалось прочитать файл');
    };
    reader.onload = function(e) {
        img.onerror = function() {
            if (onError) onError('Браузер не смог открыть это фото (часто бывает с форматом HEIC с iPhone) — попробуй выбрать JPG/PNG или пересохранить фото');
        };
        img.onload = function() {
            var w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
                if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
                else { w = Math.round(w * maxDim / h); h = maxDim; }
            }
            var canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            var dataUrl = canvas.toDataURL('image/jpeg', quality);
            callback({ base64: dataUrl.split(',')[1], mime: 'image/jpeg' });
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

// ========== ФИНАНСЫ ==========

var financesData = []; // последний загруженный список из getFinances
var allClientsForFinance = []; // полный список клиентов (включая без оплат) из getClients

async function loadFinances() {
    var list = document.getElementById('finance-clients-list');
    if (list) list.innerHTML = '<div class="no-data">Загрузка финансов...</div>';
    try {
        // Загружаем параллельно: статусы абонементов + полный список клиентов (для тех у кого ещё нет ни одной оплаты)
        var [finResp, clientsResp] = await Promise.all([
            fetch(APPS_SCRIPT_URL + '?action=getFinances'),
            fetch(APPS_SCRIPT_URL + '?action=getClients')
        ]);
        var finData = await finResp.json();
        var clientsData = await clientsResp.json();
        if (finData.error) {
            if (list) list.innerHTML = '<div class="no-data">Ошибка: ' + finData.error + '</div>';
            return;
        }
        financesData = finData.clients || [];
        allClientsForFinance = (clientsData.clients || []).filter(function(c) { return !c.archived; });

        renderFinanceSummary();
        renderFinanceList();
    } catch (error) {
        console.error('Load finances error:', error);
        if (list) list.innerHTML = '<div class="no-data">Ошибка загрузки</div>';
    }
}

function renderFinanceSummary() {
    var active = 0, expiring = 0, expired = 0;
    financesData.forEach(function(c) {
        if (c.status === 'active') active++;
        else if (c.status === 'expiring_soon' || c.status === 'expiring_week') expiring++;
        else if (c.status === 'expired') expired++;
    });
    document.getElementById('finance-active-count').textContent = active;
    document.getElementById('finance-expiring-count').textContent = expiring;
    document.getElementById('finance-expired-count').textContent = expired;
}

function renderFinanceList() {
    var list = document.getElementById('finance-clients-list');
    if (!list) return;
    // Объединяем: для каждого активного клиента смотрим есть ли оплата.
    // Если есть — берём данные из financesData, иначе показываем как «без оплат».
    var byChatId = {};
    financesData.forEach(function(c) { byChatId[c.chatId] = c; });

    var merged = [];
    allClientsForFinance.forEach(function(c) {
        var fin = byChatId[c.chatId];
        if (fin) {
            merged.push(fin);
        } else {
            merged.push({
                chatId: c.chatId,
                name: c.name,
                status: 'none',
                daysLeft: null,
                endDate: '',
                amount: null,
                lastPayment: ''
            });
        }
    });

    // Сортируем: просрочка → истекает → нет оплат → активные (по убыванию daysLeft)
    var statusOrder = { expired: 0, expiring_soon: 1, expiring_week: 2, none: 3, active: 4 };
    merged.sort(function(a, b) {
        var so = (statusOrder[a.status] || 99) - (statusOrder[b.status] || 99);
        if (so !== 0) return so;
        return (a.daysLeft || 0) - (b.daysLeft || 0);
    });

    if (merged.length === 0) {
        list.innerHTML = '<div class="no-data">Нет активных клиентов</div>';
        return;
    }

    var labels = {
        active: 'активен',
        expiring_week: 'неделя',
        expiring_soon: 'скоро',
        expired: 'истёк',
        none: 'без оплат'
    };

    list.innerHTML = merged.map(function(c) {
        var statusLabel = labels[c.status] || c.status;
        var daysText;
        if (c.status === 'none') {
            daysText = '<span class="fc-info-item">Оплат ещё нет</span>';
        } else if (c.daysLeft === null || c.daysLeft === undefined) {
            daysText = '';
        } else if (c.daysLeft < 0) {
            daysText = '<span class="fc-info-item">Истёк <strong>' + Math.abs(c.daysLeft) + ' дн. назад</strong></span>';
        } else if (c.daysLeft === 0) {
            daysText = '<span class="fc-info-item"><strong>Истекает сегодня</strong></span>';
        } else {
            daysText = '<span class="fc-info-item">Осталось <strong>' + c.daysLeft + ' дн.</strong></span>';
        }
        var endText = c.endDate ? '<span class="fc-info-item">До <strong>' + c.endDate + '</strong></span>' : '';
        var amountText = c.amount ? '<span class="fc-info-item">Последняя оплата: <strong>' + c.amount + ' ₽</strong></span>' : '';
        var safeName = (c.name || '').replace(/'/g, "\\'");
        return '<div class="finance-client-card fc-' + c.status + '">' +
            '<div class="fc-row">' +
                '<div class="fc-name">' + (c.name || '—') + '</div>' +
                '<div class="fc-status-badge b-' + c.status + '">' + statusLabel + '</div>' +
            '</div>' +
            '<div class="fc-info">' + daysText + endText + amountText + '</div>' +
            '<div class="fc-actions">' +
                '<button class="fc-pay-btn" onclick="openPaymentModal(\'' + c.chatId + '\', \'' + safeName + '\')">💰 Записать оплату</button>' +
                (c.status !== 'none' ? '<button class="fc-freeze-btn" onclick="openFreezeModal(\'' + c.chatId + '\', \'' + safeName + '\')" title="Заморозить / продлить">❄️</button>' : '') +
                '<button class="fc-delete-btn" onclick="deleteClientCompletely(\'' + c.chatId + '\', \'' + safeName + '\')" title="Удалить клиента">🗑️</button>' +
            '</div>' +
        '</div>';
    }).join('');
}

// Модалка оплаты
var currentPaymentClient = null;

function openPaymentModal(chatId, clientName) {
    currentPaymentClient = { chatId: chatId, name: clientName };
    document.getElementById('payment-modal-title').textContent = '💰 Оплата — ' + clientName;
    document.getElementById('payment-amount').value = '';
    document.getElementById('payment-months').value = '1';
    document.getElementById('payment-comment').value = '';
    var btn = document.getElementById('payment-save-btn');
    btn.disabled = false;
    btn.textContent = '💾 Записать';
    document.getElementById('payment-modal').classList.remove('hidden');
}

function closePaymentModal() {
    document.getElementById('payment-modal').classList.add('hidden');
    currentPaymentClient = null;
}

async function savePaymentFromModal() {
    if (!currentPaymentClient) return;
    var amount = parseFloat(document.getElementById('payment-amount').value);
    var months = parseInt(document.getElementById('payment-months').value);
    var comment = document.getElementById('payment-comment').value.trim();
    if (!amount || amount <= 0) {
        tg.showAlert('Укажи сумму больше 0');
        return;
    }
    if (!months || months <= 0) {
        tg.showAlert('Укажи кол-во месяцев больше 0');
        return;
    }
    var btn = document.getElementById('payment-save-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Сохранение...';
    try {
        var url = APPS_SCRIPT_URL + '?action=savePaymentDirect' +
            '&clientChatId=' + encodeURIComponent(currentPaymentClient.chatId) +
            '&clientName=' + encodeURIComponent(currentPaymentClient.name) +
            '&amount=' + encodeURIComponent(amount) +
            '&months=' + encodeURIComponent(months) +
            '&comment=' + encodeURIComponent(comment);
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            btn.disabled = false;
            btn.textContent = '💾 Записать';
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        btn.textContent = '✅ Записано';
        setTimeout(function() {
            closePaymentModal();
            loadFinances();
        }, 600);
    } catch (error) {
        console.error('Save payment error:', error);
        tg.showAlert('Ошибка соединения');
        btn.disabled = false;
        btn.textContent = '💾 Записать';
    }
}

// Модалка заморозки/продления абонемента
var currentFreezeClient = null;

function openFreezeModal(chatId, clientName) {
    currentFreezeClient = { chatId: chatId, name: clientName };
    document.getElementById('freeze-modal-title').textContent = '❄️ Заморозка — ' + clientName;
    document.getElementById('freeze-days').value = '';
    document.getElementById('freeze-comment').value = '';
    var btn = document.getElementById('freeze-save-btn');
    btn.disabled = false;
    btn.textContent = '💾 Сохранить';
    document.getElementById('freeze-modal').classList.remove('hidden');
}

function closeFreezeModal() {
    document.getElementById('freeze-modal').classList.add('hidden');
    currentFreezeClient = null;
}

async function saveFreezeFromModal() {
    if (!currentFreezeClient) return;
    var days = parseInt(document.getElementById('freeze-days').value);
    var comment = document.getElementById('freeze-comment').value.trim();
    if (!days) {
        tg.showAlert('Укажи количество дней (не 0)');
        return;
    }
    var btn = document.getElementById('freeze-save-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Сохранение...';
    try {
        var url = APPS_SCRIPT_URL + '?action=adjustSubscriptionEnd' +
            '&clientChatId=' + encodeURIComponent(currentFreezeClient.chatId) +
            '&days=' + encodeURIComponent(days) +
            '&comment=' + encodeURIComponent(comment);
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            btn.disabled = false;
            btn.textContent = '💾 Сохранить';
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        btn.textContent = '✅ Сохранено';
        setTimeout(function() {
            closeFreezeModal();
            loadFinances();
        }, 600);
    } catch (error) {
        console.error('Adjust subscription error:', error);
        tg.showAlert('Ошибка соединения');
        btn.disabled = false;
        btn.textContent = '💾 Сохранить';
    }
}

// ========== МЕСЯЧНЫЕ ОТЧЁТЫ ==========

var monthlyReports = []; // последний загруженный список превью
var currentReportSendingClient = null; // {chatId, name, msg}

async function loadMonthlyReports() {
    var list = document.getElementById('reports-list');
    if (list) list.innerHTML = '<div class="no-data">Считаю прогресс…</div>';
    try {
        var resp = await fetch(APPS_SCRIPT_URL + '?action=getMonthlyReportsPreview');
        var data = await resp.json();
        if (data.error) {
            if (list) list.innerHTML = '<div class="no-data">Ошибка: ' + data.error + '</div>';
            return;
        }
        monthlyReports = data.reports || [];
        renderMonthlyReports();
    } catch (e) {
        console.error('loadMonthlyReports error:', e);
        if (list) list.innerHTML = '<div class="no-data">Ошибка загрузки</div>';
    }
}

function renderMonthlyReports() {
    var list = document.getElementById('reports-list');
    if (!list) return;
    if (monthlyReports.length === 0) {
        list.innerHTML = '<div class="no-data">Нет активных платящих клиентов</div>';
        return;
    }
    list.innerHTML = monthlyReports.map(function(r, idx) {
        var noData = !r.hasData;
        var safeName = (r.name || '').replace(/'/g, "\\'");
        var statusClass = noData ? 's-empty' : 's-ok';
        var statusText = noData ? 'нет данных' : 'есть прогресс';
        return '<div class="report-card' + (noData ? ' no-data' : '') + '">' +
            '<div class="report-card-name">' + (r.name || '—') + '</div>' +
            '<div class="report-card-summary">' + (r.summary || '') + '</div>' +
            '<span class="report-card-status ' + statusClass + '">' + statusText + '</span>' +
            '<div class="report-card-actions">' +
                '<button class="report-preview-btn" onclick="previewReport(' + idx + ')">👁 Превью</button>' +
                '<button class="report-send-btn-card" onclick="quickSendReport(' + idx + ')"' + (noData ? ' disabled' : '') + '>📤 Отправить</button>' +
            '</div>' +
        '</div>';
    }).join('');
}

function previewReport(idx) {
    var r = monthlyReports[idx];
    if (!r) return;
    currentReportSendingClient = { chatId: r.chatId, name: r.name };
    document.getElementById('report-preview-title').textContent = '📊 ' + r.name;
    document.getElementById('report-preview-text').textContent = r.msgPreview || '(пусто — нет данных за месяц)';
    var sendBtn = document.getElementById('report-send-btn');
    sendBtn.disabled = !r.hasData;
    sendBtn.textContent = r.hasData ? '📤 Отправить клиенту' : 'Нечего отправлять';
    document.getElementById('report-preview-modal').classList.remove('hidden');
}

function closeReportPreview() {
    document.getElementById('report-preview-modal').classList.add('hidden');
    currentReportSendingClient = null;
}

async function confirmSendReport() {
    if (!currentReportSendingClient) return;
    await _doSendReport(currentReportSendingClient.chatId, currentReportSendingClient.name);
    closeReportPreview();
}

async function quickSendReport(idx) {
    var r = monthlyReports[idx];
    if (!r || !r.hasData) return;
    var confirmed = await tgConfirm('Отправить месячный отчёт клиенту «' + r.name + '»?');
    if (!confirmed) return;
    await _doSendReport(r.chatId, r.name);
}

async function _doSendReport(chatId, clientName) {
    try {
        var url = APPS_SCRIPT_URL + '?action=sendMonthlyReportToClient' +
            '&targetChatId=' + encodeURIComponent(chatId) +
            '&clientName=' + encodeURIComponent(clientName);
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Не удалось: ' + (data.error || 'ошибка'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        tg.showAlert('Отчёт отправлен клиенту «' + clientName + '» ✅');
    } catch (e) {
        console.error('send report error:', e);
        tg.showAlert('Ошибка соединения');
    }
}

async function deleteClientCompletely(chatId, clientName) {
    var msg = 'Удалить клиента «' + clientName + '» из системы?\n\nЛисты с программой и данными остаются (на случай восстановления), но клиент потеряет доступ к боту.';
    var confirmed = await tgConfirm(msg);
    if (!confirmed) return;
    try {
        var url = APPS_SCRIPT_URL + '?action=deleteClient&targetChatId=' + encodeURIComponent(chatId);
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        loadFinances();
        // Обновим основной список клиентов
        if (typeof loadAdminClients === 'function') loadAdminClients();
    } catch (error) {
        console.error('Delete client error:', error);
        tg.showAlert('Ошибка соединения');
    }
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
            var importantBadge = c.hasImportantNote
                ? '<span class="admin-card-badge admin-badge-important">⚠️ Есть заметка</span>' : '';
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
                importantBadge +
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

// ========== МАСТЕР СОЗДАНИЯ НОВОГО КЛИЕНТА (Фаза 6) ==========

var ncProgramType = 'empty'; // 'empty' | 'copy'

function openNewClientWizard() {
    // Сбросить все поля
    document.getElementById('nc-name').value = '';
    document.getElementById('nc-chatid').value = '';
    var vkRadio = document.querySelector('input[name="nc-platform"][value="vk"]');
    if (vkRadio) vkRadio.checked = true;
    _updateNcChatIdLabel();
    document.querySelectorAll('input[name="nc-gender"]').forEach(function(el) { el.checked = false; });
    document.getElementById('nc-age').value = '';
    document.getElementById('nc-height').value = '';
    document.getElementById('nc-weight').value = '';
    document.getElementById('nc-goal').value = '';
    document.getElementById('nc-level').value = '';
    document.getElementById('nc-frequency').value = '';
    document.querySelectorAll('.nc-limit-cb').forEach(function(cb) { cb.checked = false; });
    document.getElementById('nc-limit-other').value = '';
    document.getElementById('nc-inventory').value = '';
    ncProgramType = 'empty';
    selectProgramOption('empty');

    // Показать
    goToStep1();
    document.getElementById('new-client-wizard').classList.remove('hidden');
    document.body.classList.add('no-scroll');
}

function closeNewClientWizard() {
    document.getElementById('new-client-wizard').classList.add('hidden');
    document.body.classList.remove('no-scroll');
}

function goToStep1() {
    document.getElementById('nc-step-1').classList.add('active');
    document.getElementById('nc-step-2').classList.remove('active');
    document.getElementById('nc-step-meta').textContent = 'Шаг 1 из 2 — Анкета';
}

function goToStep2() {
    // Минимальная валидация
    var name = document.getElementById('nc-name').value.trim();
    var chatId = document.getElementById('nc-chatid').value.trim();
    var platformLabel = _ncSelectedPlatform() === 'telegram' ? 'Telegram chat_id' : 'VK ID клиента';
    if (!name) { tg.showAlert('Укажи имя клиента'); return; }
    if (!chatId || !/^\d+$/.test(chatId)) { tg.showAlert('Укажи ' + platformLabel + ' (число)'); return; }

    // Заполнить список источников копирования (активные клиенты)
    var sources = (adminClients || []).filter(function(c) { return !c.archived; });
    var sel = document.getElementById('nc-source-select');
    sel.innerHTML = '<option value="">— выбери клиента —</option>' + sources.map(function(c) {
        return '<option value="' + (c.sheetName || '').replace(/"/g, '&quot;') + '">' + c.name + '</option>';
    }).join('');

    document.getElementById('nc-step-1').classList.remove('active');
    document.getElementById('nc-step-2').classList.add('active');
    document.getElementById('nc-step-meta').textContent = 'Шаг 2 из 2 — Программа';
}

function selectProgramOption(type) {
    ncProgramType = type;
    document.querySelectorAll('.nc-program-option').forEach(function(el) {
        el.classList.toggle('selected', el.dataset.progType === type);
    });
    document.getElementById('nc-source-wrap').classList.toggle('hidden', type !== 'copy');
}

function _collectNewClientProfile() {
    var gender = '';
    var g = document.querySelector('input[name="nc-gender"]:checked');
    if (g) gender = g.value;

    var limits = [];
    document.querySelectorAll('.nc-limit-cb').forEach(function(cb) {
        if (cb.checked) limits.push(cb.value);
    });
    var other = (document.getElementById('nc-limit-other').value || '').trim();
    if (other) other.split(',').forEach(function(s) {
        var v = s.trim();
        if (v) limits.push(v);
    });

    // Платформа клиента: VK-id уходит на бэк с префиксом "vk_" (тот же формат,
    // что уже понимает _sendNotification/setClientChatId), Telegram — как есть,
    // числом (совместимость со старыми клиентами).
    var rawChatId = document.getElementById('nc-chatid').value.trim();
    var chatId = _ncSelectedPlatform() === 'vk' && rawChatId.indexOf('vk_') !== 0
        ? 'vk_' + rawChatId.replace(/\D/g, '')
        : rawChatId;

    return {
        name: document.getElementById('nc-name').value.trim(),
        chatId: chatId,
        gender: gender,
        age: document.getElementById('nc-age').value.trim(),
        height: document.getElementById('nc-height').value.trim(),
        weight: document.getElementById('nc-weight').value.trim(),
        goal: document.getElementById('nc-goal').value,
        level: document.getElementById('nc-level').value,
        frequency: document.getElementById('nc-frequency').value,
        limitations: limits.join(','),
        inventory: document.getElementById('nc-inventory').value
    };
}

// Создаёт нового клиента (отправляет на бэк, открывает карточку при успехе).
// Переопределяет глобальное имя — но window.createNewClient использует функцию ниже (в Apps Script роутере действие createNewClient).
async function createNewClient() {
    var btn = document.getElementById('nc-create-btn');
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Создание...';

    var profile = _collectNewClientProfile();
    var programOpts = { type: ncProgramType };
    if (ncProgramType === 'copy') {
        var src = document.getElementById('nc-source-select').value;
        if (!src) {
            tg.showAlert('Выбери клиента для копирования программы');
            btn.disabled = false;
            btn.textContent = origText;
            return;
        }
        programOpts.sourceSheetName = src;
    }

    try {
        var qs = 'action=createNewClient' +
            '&profile=' + encodeURIComponent(JSON.stringify(profile)) +
            '&programOpts=' + encodeURIComponent(JSON.stringify(programOpts));
        var resp = await fetch(APPS_SCRIPT_URL + '?' + qs);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            btn.disabled = false;
            btn.textContent = origText;
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        // Перезагружаем список клиентов
        await loadAdminClients();
        closeNewClientWizard();
        btn.disabled = false;
        btn.textContent = origText;
        // Открыть карточку только что созданного клиента
        var newC = (adminClients || []).find(function(c) { return c.chatId === data.chatId; });
        if (newC) {
            setTimeout(function() { openClientCard(data.chatId); }, 200);
        }
        tg.showAlert('✅ Клиент создан: ' + data.name);
    } catch (e) {
        console.error('Create client error:', e);
        tg.showAlert('Ошибка соединения ❌');
        btn.disabled = false;
        btn.textContent = origText;
    }
}

// ========== АРХИВ КЛИЕНТОВ ==========

async function toggleArchiveClient(chatId, archived) {
    var client = adminClients.find(function(c) { return c.chatId === chatId; });
    var name = client ? client.name : 'клиента';
    var action = archived ? ('Убрать ' + name + ' в архив?') : ('Вернуть ' + name + ' из архива?');
    var confirmed = await tgConfirm(action);
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

    // При смене клиента сбрасываем все кэши вкладок
    resetClientHistoryCache();
    notesLoadedFor = '';
    profileLoadedFor = '';
    statsLoadedFor = '';

    // Сбросить на вкладку "Программа"
    switchClientCardTab('program');
    loadClientProgram(client.sheetName);
}

async function closeClientCard() {
    var pendingCount = Object.keys(pendingExerciseEdits).length;
    if (pendingCount > 0) {
        var msg = 'Есть несохранённые изменения упражнений: ' + pendingCount + '.\n\nЗакрыть карточку без сохранения?';
        var ok = await tgConfirm(msg);
        if (!ok) return;
        discardPendingExerciseEdits();
    }
    _doCloseClientCard();
}

function _doCloseClientCard() {
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
    if (tabName === 'notes' && currentClientCard) {
        loadClientNotes(currentClientCard.name);
        loadClientProfile(currentClientCard.chatId);
    }
    if (tabName === 'stats' && currentClientCard) {
        loadClientStats(currentClientCard.name, currentClientCard.chatId);
    }
    if (tabName === 'nutrition' && currentClientCard) {
        loadClientMealPlan(currentClientCard.chatId);
    }
}

function initClientCardTabs() {
    document.querySelectorAll('.cc-tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            switchClientCardTab(btn.dataset.ccTab);
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
        });
    });
    var measSelect = document.getElementById('stats-meas-select');
    if (measSelect && !statsMeasSelectInitialized) {
        statsMeasSelectInitialized = true;
        measSelect.addEventListener('change', function() {
            statsMeasSelectedKey = measSelect.value;
            renderStatsMeasurements();
        });
    }
}

// Полные замеры клиента в статистике тренера — селектор метрики + график +
// сетка последних значений с разницей от предыдущего (та же логика, что уже
// была только на клиентской странице "Замеры" — раньше тренер видел только вес).
function renderStatsMeasurements() {
    var empty = document.getElementById('stats-meas-empty');
    var canvas = document.getElementById('stats-meas-chart');
    var select = document.getElementById('stats-meas-select');
    var grid = document.getElementById('stats-meas-latest-grid');
    if (!canvas || !empty || !grid) return;

    if (statsMeasChart) { try { statsMeasChart.destroy(); } catch (_) {} statsMeasChart = null; }

    if (statsMeasurements.length === 0) {
        empty.classList.remove('hidden');
        canvas.style.display = 'none';
        grid.innerHTML = '';
        return;
    }
    empty.classList.add('hidden');
    if (select) select.value = statsMeasSelectedKey;

    var filtered = statsMeasurements.filter(function(m) { return m[statsMeasSelectedKey] != null; });
    if (filtered.length < 2) {
        canvas.style.display = 'none';
    } else {
        canvas.style.display = '';
        var colors = {
            weight: '#1565C0', shoulders: '#455A64', chest: '#1565C0', waist: '#F57C00',
            hips: '#7B1FA2', bicep: '#2E7D32', thigh: '#C62828'
        };
        var color = colors[statsMeasSelectedKey] || '#1565C0';
        statsMeasChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: filtered.map(function(m) { return m.dateLabel; }),
                datasets: [{
                    label: MEAS_LABELS[statsMeasSelectedKey],
                    data: filtered.map(function(m) { return m[statsMeasSelectedKey]; }),
                    borderColor: color,
                    backgroundColor: color + '1A',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 4,
                    pointBackgroundColor: color,
                    pointBorderColor: '#fff'
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { ticks: { callback: function(v) { return v + ' ' + MEAS_UNITS[statsMeasSelectedKey]; } } },
                    x: { grid: { display: false } }
                }
            }
        });
    }

    // Сетка последних значений (все замеры разом) + разница от предыдущего.
    var latest = statsMeasurements[statsMeasurements.length - 1];
    var prev = statsMeasurements.length >= 2 ? statsMeasurements[statsMeasurements.length - 2] : null;
    var keys = ['weight', 'shoulders', 'chest', 'waist', 'hips', 'bicep', 'thigh'];
    grid.innerHTML = keys.map(function(key) {
        var val = latest[key];
        var diffHtml = '';
        if (prev && prev[key] != null && val != null) {
            var diff = (val - prev[key]).toFixed(1);
            if (diff > 0) diffHtml = '<span class="stats-meas-diff diff-up">+' + diff + '</span>';
            else if (diff < 0) diffHtml = '<span class="stats-meas-diff diff-down">' + diff + '</span>';
        }
        return '<div class="stats-meas-item">' +
            '<div class="stats-meas-item-value">' + (val != null ? val : '—') + diffHtml + '</div>' +
            '<div class="stats-meas-item-label">' + MEAS_LABELS[key] + '</div>' +
        '</div>';
    }).join('');
}

// ========== ПЛАН ПИТАНИЯ (вкладка "🍽 Питание" в карточке клиента) ==========

var currentMealPlanData = null;   // последний загруженный/сгенерированный план текущего клиента
var MEAL_PLAN_DEFAULT_MEALS = [
    { time: '8:00-9:00',   name: 'Завтрак' },
    { time: '13:00-14:00', name: 'Обед' },
    { time: '19:00-20:00', name: 'Ужин' },
    { time: '',            name: 'Перекус' }
];

// ── Авто-пересчёт КБЖУ в редакторе плана питания ──
// Меняешь калории — белки/жиры/углеводы (и калории/белки в каждом приёме пищи)
// пропорционально подтягиваются. Меняешь белки/жиры/углеводы — калории
// пересчитываются по формуле (белки и углеводы по 4 ккал/г, жиры — 9 ккал/г),
// а белок в приёмах пищи следует за белком (если менялся именно он).
var mpTargetsPrev = null;
var mpAutoCalcInitialized = false;

function initMealPlanAutoCalc() {
    if (mpAutoCalcInitialized) return;
    mpAutoCalcInitialized = true;
    ['calories', 'protein', 'fats', 'carbs'].forEach(function(field) {
        document.getElementById('mp-' + field).addEventListener('change', function() {
            handleMpTargetChange(field);
        });
    });
}

function handleMpTargetChange(field) {
    var prev = mpTargetsPrev || { calories: 0, protein: 0, fats: 0, carbs: 0 };
    var cur = {
        calories: parseFloat(document.getElementById('mp-calories').value) || 0,
        protein: parseFloat(document.getElementById('mp-protein').value) || 0,
        fats: parseFloat(document.getElementById('mp-fats').value) || 0,
        carbs: parseFloat(document.getElementById('mp-carbs').value) || 0
    };

    if (field === 'calories') {
        var ratio = prev.calories > 0 ? cur.calories / prev.calories : null;
        if (ratio) {
            document.getElementById('mp-protein').value = Math.round(prev.protein * ratio) || '';
            document.getElementById('mp-fats').value = Math.round(prev.fats * ratio) || '';
            document.getElementById('mp-carbs').value = Math.round(prev.carbs * ratio) || '';
            _scaleMealFields(ratio, ratio);
        }
    } else {
        // Белки/жиры/углеводы → калории считаем по формуле, а не пропорцией
        var newCalories = Math.round(cur.protein * 4 + cur.fats * 9 + cur.carbs * 4);
        document.getElementById('mp-calories').value = newCalories || '';
        var calRatio = prev.calories > 0 ? newCalories / prev.calories : null;
        var proteinRatio = (field === 'protein' && prev.protein > 0) ? cur.protein / prev.protein : null;
        _scaleMealFields(calRatio, proteinRatio);
    }

    // Перечитываем поля начисто — в обеих ветках выше значения могли поменяться
    // (пропорционально или по формуле), снимок должен отражать то, что реально в форме.
    mpTargetsPrev = {
        calories: parseFloat(document.getElementById('mp-calories').value) || 0,
        protein: parseFloat(document.getElementById('mp-protein').value) || 0,
        fats: parseFloat(document.getElementById('mp-fats').value) || 0,
        carbs: parseFloat(document.getElementById('mp-carbs').value) || 0
    };
}

function _scaleMealFields(calRatio, proteinRatio) {
    document.querySelectorAll('.mp-meal-block').forEach(function(block) {
        if (calRatio) {
            var calInput = block.querySelector('[data-mp="calories"]');
            var calVal = parseFloat(calInput.value) || 0;
            if (calVal) calInput.value = Math.round(calVal * calRatio);
        }
        if (proteinRatio) {
            var protInput = block.querySelector('[data-mp="protein"]');
            var protVal = parseFloat(protInput.value) || 0;
            if (protVal) protInput.value = Math.round(protVal * proteinRatio);
        }
    });
}

// Собирает читаемое "Состав" из foods[] (для показа/редактирования одной строкой) —
// AI присылает продукты по отдельности, а для ручного ввода это одна строка текста.
function _mealFoodsToText(foods) {
    return (foods || []).map(function(f) {
        return f.name + (f.grams ? ' (' + f.grams + 'г)' : '');
    }).join(', ');
}

async function loadClientMealPlan(chatId) {
    var box = document.getElementById('mp-summary');
    box.innerHTML = '<div class="no-data">Загрузка плана питания...</div>';
    currentMealPlanData = null;
    try {
        var resp = await fetch(APPS_SCRIPT_URL + '?action=getMealPlanForClient&targetChatId=' + encodeURIComponent(chatId));
        var data = await resp.json();
        if (data.error) { box.innerHTML = '<div class="no-data">Не удалось загрузить ❌</div>'; return; }
        if (!data.exists) {
            box.innerHTML = '<div class="no-data">Плана питания пока нет — составь вручную или сгенерируй через ИИ</div>';
            return;
        }
        currentMealPlanData = data;
        renderMealPlanSummary(data);
    } catch (e) {
        console.error('loadClientMealPlan failed:', e);
        box.innerHTML = '<div class="no-data">Не удалось загрузить ❌</div>';
    }
}

function renderMealPlanSummary(data) {
    var box = document.getElementById('mp-summary');
    var html = '<div class="mp-macro-grid">' +
        '<div class="mp-macro-card"><div class="mp-macro-value">' + (data.target_calories || 0) + '</div><div class="mp-macro-label">ккал</div></div>' +
        '<div class="mp-macro-card"><div class="mp-macro-value">' + (data.target_protein || 0) + '</div><div class="mp-macro-label">белки</div></div>' +
        '<div class="mp-macro-card"><div class="mp-macro-value">' + (data.target_fats || 0) + '</div><div class="mp-macro-label">жиры</div></div>' +
        '<div class="mp-macro-card"><div class="mp-macro-value">' + (data.target_carbs || 0) + '</div><div class="mp-macro-label">углеводы</div></div>' +
    '</div>';
    (data.meals || []).forEach(function(meal) {
        html += '<div class="mp-meal-summary-item">' +
            '<div class="mp-meal-summary-name">' + (meal.name || 'Приём пищи') + '</div>' +
            '<div class="mp-meal-summary-meta">' + (meal.time || '') +
                (meal.total_calories ? ' · ' + meal.total_calories + ' ккал' : '') +
                (meal.total_protein ? ' · Б: ' + meal.total_protein + 'г' : '') + '</div>' +
            (meal.foods && meal.foods.length ? '<div class="mp-meal-summary-desc">' + _mealFoodsToText(meal.foods) + '</div>' : '') +
        '</div>';
    });
    if (data.notes) {
        html += '<div class="mp-notes-summary">💬 ' + data.notes + '</div>';
    }
    box.innerHTML = html;
}

function openMealPlanEditor() {
    var d = currentMealPlanData;
    document.getElementById('mp-calories').value = d ? d.target_calories : '';
    document.getElementById('mp-protein').value = d ? d.target_protein : '';
    document.getElementById('mp-fats').value = d ? d.target_fats : '';
    document.getElementById('mp-carbs').value = d ? d.target_carbs : '';
    document.getElementById('mp-notes').value = d ? (d.notes || '') : '';
    mpTargetsPrev = {
        calories: (d && d.target_calories) || 0,
        protein: (d && d.target_protein) || 0,
        fats: (d && d.target_fats) || 0,
        carbs: (d && d.target_carbs) || 0
    };
    initMealPlanAutoCalc();

    var meals = (d && d.meals && d.meals.length) ? d.meals : MEAL_PLAN_DEFAULT_MEALS;
    var list = document.getElementById('mp-meals-list');
    list.innerHTML = meals.map(function(meal, i) {
        return '<div class="mp-meal-block">' +
            '<div class="mp-meal-block-title">Приём пищи ' + (i + 1) + '</div>' +
            '<div class="mp-meal-row">' +
                '<input type="text" class="ex-editor-input" data-mp="name" placeholder="Название" value="' + (meal.name || '').replace(/"/g, '&quot;') + '">' +
                '<input type="text" class="ex-editor-input" data-mp="time" placeholder="Время" value="' + (meal.time || '').replace(/"/g, '&quot;') + '">' +
            '</div>' +
            '<div class="mp-meal-row">' +
                '<input type="number" inputmode="numeric" class="ex-editor-input" data-mp="calories" placeholder="Калории" value="' + (meal.total_calories || '') + '">' +
                '<input type="number" inputmode="numeric" class="ex-editor-input" data-mp="protein" placeholder="Белки, г" value="' + (meal.total_protein || '') + '">' +
            '</div>' +
            '<textarea class="ex-editor-textarea" data-mp="desc" rows="2" placeholder="Состав (например: Овсянка 80г, банан 1шт)">' +
                (meal.foods ? _mealFoodsToText(meal.foods) : '') +
            '</textarea>' +
        '</div>';
    }).join('');

    document.getElementById('mp-editor-modal').classList.remove('hidden');
    document.body.classList.add('no-scroll');
}

function closeMealPlanEditor() {
    document.getElementById('mp-editor-modal').classList.add('hidden');
    document.body.classList.remove('no-scroll');
}

async function saveMealPlanFromEditor() {
    if (!currentClientCard) return;
    var btn = document.getElementById('mp-save-btn');
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Сохранение...';

    var meals = [];
    document.querySelectorAll('#mp-meals-list .mp-meal-block').forEach(function(block) {
        var name = block.querySelector('[data-mp="name"]').value.trim();
        var time = block.querySelector('[data-mp="time"]').value.trim();
        var calories = parseInt(block.querySelector('[data-mp="calories"]').value, 10) || 0;
        var protein = parseInt(block.querySelector('[data-mp="protein"]').value, 10) || 0;
        var desc = block.querySelector('[data-mp="desc"]').value.trim();
        if (!name && !calories && !desc) return; // полностью пустой блок — пропускаем
        meals.push({
            name: name || 'Приём пищи',
            time: time,
            foods: desc ? [{ name: desc, grams: 0, calories: calories, protein: protein, fats: 0, carbs: 0 }] : [],
            total_calories: calories,
            total_protein: protein
        });
    });

    var payload = {
        client_name: currentClientCard.name,
        plan: {
            target_calories: parseInt(document.getElementById('mp-calories').value, 10) || 0,
            target_protein: parseInt(document.getElementById('mp-protein').value, 10) || 0,
            target_fats: parseInt(document.getElementById('mp-fats').value, 10) || 0,
            target_carbs: parseInt(document.getElementById('mp-carbs').value, 10) || 0,
            meals: meals,
            notes: document.getElementById('mp-notes').value.trim()
        },
        client_data: {
            weight: '', height: '', age: '', goal: '', allergies: ''
        }
    };

    try {
        var myChatId = _myChatId();
        var resp = await fetch(APPS_SCRIPT_URL + '?action=saveMealPlan&chatId=' + encodeURIComponent(myChatId), {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось сохранить'));
            btn.disabled = false;
            btn.textContent = origText;
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        closeMealPlanEditor();
        btn.disabled = false;
        btn.textContent = origText;
        await loadClientMealPlan(currentClientCard.chatId);
        tg.showAlert('✅ План питания сохранён');
    } catch (e) {
        console.error('saveMealPlanFromEditor error:', e);
        tg.showAlert('Ошибка соединения ❌');
        btn.disabled = false;
        btn.textContent = origText;
    }
}

async function openMealPlanAiForm() {
    if (!currentClientCard) return;
    document.getElementById('mp-ai-weight').value = '';
    document.getElementById('mp-ai-height').value = '';
    document.getElementById('mp-ai-age').value = '';
    document.getElementById('mp-ai-goal').value = '';
    document.getElementById('mp-ai-allergies').value = '';
    try {
        var resp = await fetch(APPS_SCRIPT_URL + '?action=getClientProfile&targetChatId=' + encodeURIComponent(currentClientCard.chatId));
        var p = await resp.json();
        if (!p.error) {
            document.getElementById('mp-ai-weight').value = p.weight || '';
            document.getElementById('mp-ai-height').value = p.height || '';
            document.getElementById('mp-ai-age').value = p.age || '';
            var goalLabels = { loss: 'Похудение', mass: 'Набор массы', tone: 'Тонус / поддержание', strength: 'Сила' };
            document.getElementById('mp-ai-goal').value = goalLabels[p.goal] || p.goal || '';
        }
    } catch (e) { /* анкета не обязательна — просто оставим поля пустыми */ }

    document.getElementById('mp-ai-modal').classList.remove('hidden');
    document.body.classList.add('no-scroll');
}

function closeMealPlanAiForm() {
    document.getElementById('mp-ai-modal').classList.add('hidden');
    document.body.classList.remove('no-scroll');
}

async function runMealPlanAiGeneration() {
    if (!currentClientCard) return;
    var btn = document.getElementById('mp-ai-generate-btn');
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '🤖 Генерирую... (~30 сек)';

    var payload = {
        clientName: currentClientCard.name,
        weight: document.getElementById('mp-ai-weight').value.trim(),
        height: document.getElementById('mp-ai-height').value.trim(),
        age: document.getElementById('mp-ai-age').value.trim(),
        goal: document.getElementById('mp-ai-goal').value.trim(),
        allergies: document.getElementById('mp-ai-allergies').value.trim()
    };

    try {
        var resp = await fetch(APPS_SCRIPT_URL + '?action=generateMealPlanAI', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        var data = await resp.json();
        btn.disabled = false;
        btn.textContent = origText;
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось сгенерировать'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        closeMealPlanAiForm();
        // Открываем редактор сразу с результатом ИИ — тренер проверяет/правит перед сохранением.
        currentMealPlanData = Object.assign({ exists: true, name: currentClientCard.name }, data.plan);
        openMealPlanEditor();
    } catch (e) {
        console.error('runMealPlanAiGeneration error:', e);
        tg.showAlert('Ошибка соединения ❌');
        btn.disabled = false;
        btn.textContent = origText;
    }
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
        // После рендера DOM пересоздан — заново подсвечиваем строки, у которых остались
        // не сохранённые правки (на случай если очередь не была пуста перед reload'ом).
        Object.keys(pendingExerciseEdits).forEach(function(rowIdx) {
            markExerciseDirty(rowIdx);
        });
        updateBulkSaveBar();
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
function duplicateWeekFlow() {
    if (!currentClientCard) return;
    var name = currentClientCard.name || 'клиента';
    document.getElementById('new-week-client-line').textContent =
        'Для ' + name + '. План упражнений остаётся тем же, факты прошлой недели будут стёрты.';
    document.getElementById('new-week-autoprogress').checked = true;
    document.getElementById('new-week-modal').classList.remove('hidden');
    document.body.classList.add('no-scroll');
}

function closeNewWeekModal() {
    document.getElementById('new-week-modal').classList.add('hidden');
    document.body.classList.remove('no-scroll');
}

async function confirmNewWeek() {
    if (!currentClientCard) return;
    var autoProgress = document.getElementById('new-week-autoprogress').checked;
    var btn = document.getElementById('new-week-create-btn');
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Создание...';

    try {
        var url = APPS_SCRIPT_URL + '?action=duplicateClientWeek' +
            '&sheetName=' + encodeURIComponent(currentClientCard.sheetName) +
            '&autoProgress=' + (autoProgress ? 'true' : 'false');
        var resp = await fetch(url);
        var data = await resp.json();
        btn.disabled = false;
        btn.textContent = origText;
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        closeNewWeekModal();
        if (data.newTitle) {
            currentClientCard.weekTitle = data.newTitle;
            document.getElementById('cc-meta').textContent = data.newTitle;
        }
        await loadClientProgram(currentClientCard.sheetName);
        tg.showAlert('✅ Новая неделя создана: ' + (data.newTitle || '') +
            (autoProgress ? '\n\nВеса подобраны автоматически — проверь и поправь при желании.' : ''));
    } catch (error) {
        console.error('Duplicate week error:', error);
        btn.disabled = false;
        btn.textContent = origText;
        tg.showAlert('Ошибка соединения ❌');
    }
}

// Отправить клиенту уведомление о том, что программа обновлена
async function notifyClientFlow() {
    if (!currentClientCard || !currentClientCard.chatId) return;
    var name = currentClientCard.name || 'клиенту';
    var confirmed = await tgConfirm('Отправить ' + name + ' уведомление о том, что программа обновлена?');
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

// Объединить упражнение с идущим сразу за ним в сет/трисет — задним числом,
// без специальной формы добавления. Суперсет/трисет в этом коде — это просто
// префикс "Сет:"/"Трисет:" у ПЕРВОГО упражнения группы + соседние строки
// (см. isSupersetStart/isTrisetStart/groupExercises выше), так что достаточно
// переписать название через уже существующее updateClientExercise.
async function mergeExercises(rowIndex, isUpgradeToTriset) {
    var ex = currentProgramExercisesByRow[rowIndex];
    if (!ex || !currentClientCard) return;
    var currentName = cleanExerciseName(ex.exercise);
    var newPrefix = isUpgradeToTriset ? 'Трисет: ' : 'Сет: ';
    var msg = isUpgradeToTriset
        ? 'Сделать трисет из «' + currentName + '» и следующего упражнения?'
        : 'Объединить «' + currentName + '» со следующим упражнением в сет?';
    var confirmed = await tgConfirm(msg);
    if (!confirmed) return;
    try {
        var url = APPS_SCRIPT_URL + '?action=updateClientExercise' +
            '&sheetName=' + encodeURIComponent(currentClientCard.sheetName) +
            '&rowIndex=' + rowIndex +
            '&exercise=' + encodeURIComponent(newPrefix + currentName);
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        await loadClientProgram(currentClientCard.sheetName);
    } catch (e) {
        tg.showAlert('Ошибка соединения ❌');
    }
}

// Разъединить сет/трисет обратно на отдельные упражнения — убираем префикс у
// первого упражнения группы, остальные строки не трогаем (они и так обычные).
async function splitGroup(firstRowIndex) {
    var ex = currentProgramExercisesByRow[firstRowIndex];
    if (!ex || !currentClientCard) return;
    var confirmed = await tgConfirm('Разъединить группу обратно на отдельные упражнения?');
    if (!confirmed) return;
    try {
        var url = APPS_SCRIPT_URL + '?action=updateClientExercise' +
            '&sheetName=' + encodeURIComponent(currentClientCard.sheetName) +
            '&rowIndex=' + firstRowIndex +
            '&exercise=' + encodeURIComponent(cleanExerciseName(ex.exercise));
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        await loadClientProgram(currentClientCard.sheetName);
    } catch (e) {
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
        container.innerHTML = '<div class="no-data">В программе пока нет упражнений</div>' +
            '<button class="cc-add-day-btn" onclick="showAddDayDialog()">+ Добавить день тренировки</button>';
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
        var groupsHtml = groups.map(function(group, gi) {
            var nextGroup = groups[gi + 1];
            var firstRowIdx = group.exercises[0].rowIndex;
            // Объединять/разъединять можно только соседние группы — суперсет/трисет и так
            // определяются исключительно соседством строк, ничего другого не нужно.
            var actionsHtml = '';
            if (group.type === 'single' && nextGroup && nextGroup.type === 'single' && firstRowIdx) {
                actionsHtml = '<button class="cc-group-action-btn" onclick="mergeExercises(' + firstRowIdx + ', false)">🔗 Объединить со следующим</button>';
            } else if (group.type === 'superset' && nextGroup && nextGroup.type === 'single' && firstRowIdx) {
                actionsHtml = '<button class="cc-group-action-btn" onclick="mergeExercises(' + firstRowIdx + ', true)">🔗+ Сделать трисет</button>';
            } else if ((group.type === 'superset' || group.type === 'triset') && firstRowIdx) {
                actionsHtml = '<button class="cc-group-action-btn cc-group-action-split" onclick="splitGroup(' + firstRowIdx + ')">✂️ Разъединить</button>';
            }
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
                        actionsHtml +
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
                        actionsHtml +
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
                    actionsHtml +
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
            // Защита: ISO-дата иногда попадает в reps/weightPlan
            var repsClean = ex.reps;
            if (typeof repsClean === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(repsClean)) repsClean = '';
            var weightPlanClean = ex.weightPlan;
            if (typeof weightPlanClean === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(weightPlanClean)) weightPlanClean = '';

            var fact = '';
            if (ex.weightFact !== '' && ex.weightFact != null) {
                fact = ex.weightFact + ' кг';
                if (ex.repsFact !== '' && ex.repsFact != null) fact += ' × ' + ex.repsFact;
            }

            // Бейдж с фидбэком (Легко/Норм/Тяжело/Не вытянул) — приходит с бэка
            var feedbackHtml = '';
            if (ex.feedback && ex.feedback.label) {
                feedbackHtml = '<span class="hh-ex-feedback hh-fb-' + ex.feedback.code + '">' +
                    ex.feedback.emoji + ' ' + ex.feedback.label +
                '</span>';
            }

            var rpeText = (ex.rpe !== '' && ex.rpe != null) ? ' · RPE ' + ex.rpe : '';

            var commentHtml = (ex.comment && ex.comment.toString().trim())
                ? '<div class="hh-ex-comment">💬 ' + ex.comment + '</div>' : '';

            var planText = '';
            if (weightPlanClean) {
                var repsPart = repsClean ? ' × ' + repsClean : '';
                planText = '<span class="hh-ex-plan">план: ' + weightPlanClean + repsPart + '</span>';
            }
            return '<div class="hh-ex">' +
                '<div class="hh-ex-name">' + cleanExerciseName(ex.exercise) + '</div>' +
                '<div class="hh-ex-fact-row">' +
                    (fact ? '<span class="hh-ex-fact-value">' + fact + '</span>' : '<span class="hh-ex-skipped">не выполнено</span>') +
                    '<span class="hh-ex-rpe">' + rpeText + '</span>' +
                    feedbackHtml +
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

// ========== ВКЛАДКА «СТАТИСТИКА» (Фаза 5) ==========

var statsLoadedFor = '';
var statsWeightChart = null;
var statsMeasChart = null;
var statsMeasSelectedKey = 'weight';
var statsMeasSelectInitialized = false;
var statsMeasurements = []; // [{dateLabel, dateObj, weight, shoulders, chest, waist, hips, bicep, thigh}]
var statsPhotoCompareMode = false;
var statsPhotoCompareSelected = []; // индексы в statsProgressPhotos, максимум 3

function toggleStatsPhotoCompare() {
    statsPhotoCompareMode = !statsPhotoCompareMode;
    statsPhotoCompareSelected = [];
    document.getElementById('stats-compare-toggle').textContent = statsPhotoCompareMode ? '✕ Отмена' : '🔍 Сравнить';
    document.getElementById('stats-compare-hint').classList.toggle('hidden', !statsPhotoCompareMode);
    renderStatsPhotoCompareStrip();
    renderClientStats();
}

function toggleStatsPhotoSelect(i) {
    var idx = statsPhotoCompareSelected.indexOf(i);
    if (idx !== -1) {
        statsPhotoCompareSelected.splice(idx, 1);
    } else {
        if (statsPhotoCompareSelected.length >= 3) statsPhotoCompareSelected.shift(); // максимум 3 — старейшее вылетает
        statsPhotoCompareSelected.push(i);
    }
    renderStatsPhotoCompareStrip();
    renderClientStats();
}

// Полоса сравнения — выбранные фото рядом в хронологическом порядке, с датой,
// весом (если есть за эту дату) и промежутком между соседними датами — тот
// же стиль, что коллега Matvey показывал ("каждые 6 недель согласно датам").
function renderStatsPhotoCompareStrip() {
    var strip = document.getElementById('stats-compare-strip');
    if (!strip) return;
    if (!statsPhotoCompareMode || statsPhotoCompareSelected.length < 2) {
        strip.innerHTML = '';
        strip.classList.remove('active');
        return;
    }
    strip.classList.add('active');
    var items = statsPhotoCompareSelected
        .map(function(i) { return statsProgressPhotos[i]; })
        .filter(Boolean)
        .sort(function(a, b) { return a.dateObj - b.dateObj; });

    strip.innerHTML = items.map(function(p, i) {
        var gapHtml = '';
        if (i > 0 && p.dateObj && items[i - 1].dateObj) {
            var days = Math.round((p.dateObj - items[i - 1].dateObj) / 86400000);
            gapHtml = '<div class="stats-compare-gap">→ ' + days + ' дн.</div>';
        }
        return (gapHtml ? gapHtml : '') +
            '<div class="stats-compare-item">' +
                '<img src="' + p.url + '">' +
                '<div class="stats-compare-date">' + p.date + '</div>' +
                (p.weight ? '<div class="stats-compare-weight">' + p.weight + ' кг</div>' : '') +
            '</div>';
    }).join('');
}
var statsVolumeChart = null;
var statsBodyWeights = []; // [{date, weight}]
var statsProgressPhotos = []; // [{date, url}]

async function loadClientStats(clientName, chatId) {
    if (!clientName) return;
    if (statsLoadedFor === clientName) return; // уже посчитано

    // Сначала убеждаемся что есть история (для PR/объёма/consistency)
    if (clientHistoryLoadedFor !== clientName) {
        await loadClientHistory(clientName);
    }
    // Также подгружаем замеры (для графика веса тела и фото прогресса)
    statsBodyWeights = [];
    statsProgressPhotos = [];
    statsMeasurements = [];
    statsPhotoCompareMode = false;
    statsPhotoCompareSelected = [];
    if (chatId) {
        try {
            var url = APPS_SCRIPT_URL + '?action=getMeasurements&chatId=' + encodeURIComponent(chatId);
            var resp = await fetch(url);
            var data = await resp.json();
            if (data && data.measurements) {
                statsBodyWeights = (data.measurements || [])
                    .filter(function(m) { return m && m.weight != null && parseFloat(m.weight) > 0; })
                    .map(function(m) {
                        // m.date может быть «dd.MM.yyyy» — конвертируем в Date
                        var d = _parseDateRu(m.date);
                        return { dateLabel: formatDate(m.date), dateObj: d ? d.getTime() : 0, weight: parseFloat(m.weight) };
                    })
                    .filter(function(x) { return x.dateObj > 0; })
                    .sort(function(a, b) { return a.dateObj - b.dateObj; });
                statsProgressPhotos = (data.measurements || [])
                    .filter(function(m) { return m && m.photoUrl; })
                    .map(function(m) {
                        var d = _parseDateRu(m.date);
                        return {
                            date: formatDate(m.date), dateObj: d ? d.getTime() : 0, url: m.photoUrl,
                            weight: m.weight != null ? parseFloat(m.weight) : null
                        };
                    })
                    .reverse(); // свежие сверху
                // Полный набор замеров (не только вес) — для селектора графика ниже.
                statsMeasurements = (data.measurements || [])
                    .map(function(m) {
                        var d = _parseDateRu(m.date);
                        return {
                            dateLabel: formatDate(m.date), dateObj: d ? d.getTime() : 0,
                            weight: m.weight != null ? parseFloat(m.weight) : null,
                            shoulders: m.shoulders != null ? parseFloat(m.shoulders) : null,
                            chest: m.chest != null ? parseFloat(m.chest) : null,
                            waist: m.waist != null ? parseFloat(m.waist) : null,
                            hips: m.hips != null ? parseFloat(m.hips) : null,
                            bicep: m.bicep != null ? parseFloat(m.bicep) : null,
                            thigh: m.thigh != null ? parseFloat(m.thigh) : null
                        };
                    })
                    .filter(function(x) { return x.dateObj > 0; })
                    .sort(function(a, b) { return a.dateObj - b.dateObj; });
            }
        } catch (_) {}
    }

    statsLoadedFor = clientName;
    renderClientStats();
}

function _parseDateRu(s) {
    if (!s) return null;
    var str = s.toString().trim();
    if (str.indexOf('.') !== -1) {
        var parts = str.split('.');
        if (parts.length >= 3) {
            return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
        }
    }
    var d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}

function _isoWeekKey(d) {
    // Возвращает 'yyyy-WW' (ISO week)
    var tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    var yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    var weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
    return tmp.getUTCFullYear() + '-W' + (weekNo < 10 ? '0' + weekNo : weekNo);
}

function renderClientStats() {
    var history = (clientHistoryCache[currentClientCard.name] || []).slice();
    var now = Date.now();
    var msDay = 24 * 60 * 60 * 1000;

    // ── 1. Регулярность за 4 недели ──
    var period = 28 * msDay;
    var datesIn4Weeks = {};
    history.forEach(function(day) {
        if (now - day.dateObj <= period) {
            // Используем YYYY-MM-DD как ключ
            var d = new Date(day.dateObj);
            var k = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
            datesIn4Weeks[k] = true;
        }
    });
    var actual = Object.keys(datesIn4Weeks).length;

    // Ожидаемое: из анкеты freq × 4 (если есть), иначе средняя частота за всю историю
    var expected = 0;
    var freqField = document.getElementById('prof-frequency');
    var freqVal = freqField ? parseInt(freqField.value, 10) : 0;
    if (freqVal > 0) {
        expected = freqVal * 4;
    } else if (history.length > 0) {
        // средняя за всю историю: уник дат / (диапазон в днях / 28)
        var firstDate = history[history.length - 1].dateObj;
        var spanDays = Math.max(1, (now - firstDate) / msDay);
        // считаем уникальные даты во всей истории
        var allDates = {};
        history.forEach(function(day) {
            var d = new Date(day.dateObj);
            var k = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
            allDates[k] = true;
        });
        var avgPer28 = Object.keys(allDates).length / spanDays * 28;
        expected = Math.max(8, Math.round(avgPer28)); // минимум 8 (≈ 2 раза в неделю)
    } else {
        expected = 12; // дефолт
    }

    var percent = expected > 0 ? Math.round(actual / expected * 100) : 0;
    if (percent > 100) percent = 100;

    document.getElementById('stats-consistency-percent').textContent = percent + '%';
    var subTxt = actual + ' тренировок из ~' + expected + ' ожидаемых';
    if (freqVal > 0) subTxt += ' (по анкете ' + freqVal + ' в неделю)';
    document.getElementById('stats-consistency-sub').textContent = subTxt;
    var fill = document.getElementById('stats-consistency-fill');
    fill.style.width = Math.max(2, percent) + '%';
    fill.className = 'stats-consistency-fill';
    if (percent >= 85)      fill.classList.add('cc-fill-good');
    else if (percent >= 60) fill.classList.add('cc-fill-mid');
    else                    fill.classList.add('cc-fill-low');

    // ── 2. Топ-3 рекорда ──
    var bestByExercise = {};
    history.forEach(function(day) {
        day.exercises.forEach(function(ex) {
            var name = cleanExerciseName(ex.exercise);
            if (!name) return;
            var w = parseFloat(ex.weightFact);
            var r = parseFloat(ex.repsFact);
            if (isNaN(w) || w <= 0) return;
            var cur = bestByExercise[name];
            if (!cur || w > cur.weight || (w === cur.weight && (r || 0) > (cur.reps || 0))) {
                bestByExercise[name] = { weight: w, reps: r || 0, date: day.date };
            }
        });
    });
    var prs = Object.keys(bestByExercise).map(function(name) {
        var b = bestByExercise[name];
        return { name: name, weight: b.weight, reps: b.reps, date: b.date };
    });
    prs.sort(function(a, b) { return b.weight - a.weight; });
    prs = prs.slice(0, 3);

    var prsEl = document.getElementById('stats-prs-list');
    if (prs.length === 0) {
        prsEl.innerHTML = '<div class="no-data">Нет данных</div>';
    } else {
        prsEl.innerHTML = prs.map(function(pr, idx) {
            var medal = ['🥇', '🥈', '🥉'][idx] || '🏅';
            var repsTxt = pr.reps ? ' × ' + pr.reps : '';
            return '<div class="stats-pr-row">' +
                '<div class="stats-pr-medal">' + medal + '</div>' +
                '<div class="stats-pr-info">' +
                    '<div class="stats-pr-name">' + pr.name + '</div>' +
                    '<div class="stats-pr-date">' + pr.date + '</div>' +
                '</div>' +
                '<div class="stats-pr-weight">' + pr.weight + ' кг' + repsTxt + '</div>' +
            '</div>';
        }).join('');
    }

    // ── 3. График веса тела ──
    var wEmpty = document.getElementById('stats-weight-empty');
    var wCanvas = document.getElementById('stats-weight-chart');
    if (statsWeightChart) { try { statsWeightChart.destroy(); } catch (_) {} statsWeightChart = null; }
    if (statsBodyWeights.length < 2) {
        wEmpty.classList.remove('hidden');
        wCanvas.style.display = 'none';
        if (statsBodyWeights.length === 1) {
            wEmpty.textContent = 'Только один замер: ' + statsBodyWeights[0].weight + ' кг (' + statsBodyWeights[0].dateLabel + ')';
        } else {
            wEmpty.textContent = 'Клиент ещё не вносил замеры веса';
        }
    } else {
        wEmpty.classList.add('hidden');
        wCanvas.style.display = '';
        statsWeightChart = new Chart(wCanvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: statsBodyWeights.map(function(x) { return x.dateLabel; }),
                datasets: [{
                    label: 'Вес',
                    data: statsBodyWeights.map(function(x) { return x.weight; }),
                    borderColor: '#1565C0',
                    backgroundColor: 'rgba(21,101,192,0.10)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 4,
                    pointBackgroundColor: '#1565C0',
                    pointBorderColor: '#fff'
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { ticks: { callback: function(v) { return v + ' кг'; } } },
                    x: { grid: { display: false } }
                }
            }
        });
    }

    // ── 3a2. Полные замеры (селектор + график, не только вес) ──
    renderStatsMeasurements();

    // ── 3b. Фото прогресса ──
    var pGrid = document.getElementById('stats-photos-grid');
    var pEmpty = document.getElementById('stats-photos-empty');
    var compareToggle = document.getElementById('stats-compare-toggle');
    if (compareToggle) compareToggle.classList.toggle('hidden', statsProgressPhotos.length < 2);
    renderStatsPhotoCompareStrip();
    if (statsProgressPhotos.length === 0) {
        pGrid.innerHTML = '';
        pEmpty.classList.remove('hidden');
    } else {
        pEmpty.classList.add('hidden');
        pGrid.innerHTML = statsProgressPhotos.map(function(p, i) {
            var selected = statsPhotoCompareMode && statsPhotoCompareSelected.indexOf(i) !== -1;
            var clickHandler = statsPhotoCompareMode
                ? 'toggleStatsPhotoSelect(' + i + ')'
                : 'tg.openLink(\'' + p.url + '\')';
            return '<div class="stats-photo-item' + (selected ? ' selected' : '') + '" onclick="' + clickHandler + '">' +
                '<img src="' + p.url + '">' +
                (selected ? '<div class="stats-photo-check">✓</div>' : '') +
                '<div class="stats-photo-date">' + p.date + (p.weight ? ' · ' + p.weight + 'кг' : '') + '</div>' +
            '</div>';
        }).join('');
    }

    // ── 4. Объём по неделям ──
    var volumeByWeek = {};   // 'YYYY-WW' → { volume, weekStart }
    history.forEach(function(day) {
        var d = new Date(day.dateObj);
        var key = _isoWeekKey(d);
        if (!volumeByWeek[key]) volumeByWeek[key] = { volume: 0, weekStart: d.getTime() };
        else if (d.getTime() < volumeByWeek[key].weekStart) volumeByWeek[key].weekStart = d.getTime();
        day.exercises.forEach(function(ex) {
            var w = parseFloat(ex.weightFact) || 0;
            var r = parseFloat(ex.repsFact) || 0;
            var s = parseFloat(ex.sets) || 1;
            if (w > 0 && r > 0) volumeByWeek[key].volume += w * r * s;
        });
    });
    var volList = Object.keys(volumeByWeek).map(function(k) {
        return { week: k, volume: Math.round(volumeByWeek[k].volume), start: volumeByWeek[k].weekStart };
    });
    volList.sort(function(a, b) { return a.start - b.start; });
    volList = volList.slice(-12);

    var vEmpty = document.getElementById('stats-volume-empty');
    var vCanvas = document.getElementById('stats-volume-chart');
    if (statsVolumeChart) { try { statsVolumeChart.destroy(); } catch (_) {} statsVolumeChart = null; }
    if (volList.length === 0) {
        vEmpty.classList.remove('hidden');
        vCanvas.style.display = 'none';
    } else {
        vEmpty.classList.add('hidden');
        vCanvas.style.display = '';
        statsVolumeChart = new Chart(vCanvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: volList.map(function(v) {
                    var d = new Date(v.start);
                    return d.getDate() + '.' + (d.getMonth() + 1);
                }),
                datasets: [{
                    label: 'Тоннаж',
                    data: volList.map(function(v) { return v.volume; }),
                    backgroundColor: 'rgba(67,160,71,0.65)',
                    borderColor: '#43A047',
                    borderWidth: 1.5,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(ctx2) { return ctx2.parsed.y.toLocaleString('ru-RU') + ' кг'; }
                        }
                    }
                },
                scales: {
                    y: { beginAtZero: true, ticks: { callback: function(v) { return (v / 1000).toFixed(1) + 'т'; } } },
                    x: { grid: { display: false } }
                }
            }
        });
    }

    // ── 5. Прогресс по упражнениям (последние 30 vs предыдущие 30) ──
    var thirty = 30 * msDay;
    var sixty  = 60 * msDay;
    var bestRecent = {}, bestPrev = {};
    history.forEach(function(day) {
        var age = now - day.dateObj;
        day.exercises.forEach(function(ex) {
            var name = cleanExerciseName(ex.exercise);
            if (!name) return;
            var w = parseFloat(ex.weightFact);
            if (isNaN(w) || w <= 0) return;
            if (age <= thirty) {
                if (!bestRecent[name] || w > bestRecent[name]) bestRecent[name] = w;
            } else if (age <= sixty) {
                if (!bestPrev[name] || w > bestPrev[name]) bestPrev[name] = w;
            }
        });
    });
    var progress = Object.keys(bestRecent).filter(function(name) {
        return bestPrev[name] != null;
    }).map(function(name) {
        return { name: name, recent: bestRecent[name], prev: bestPrev[name], gain: bestRecent[name] - bestPrev[name] };
    });
    progress.sort(function(a, b) { return b.gain - a.gain; });
    progress = progress.slice(0, 5);

    var progEl = document.getElementById('stats-progress-list');
    if (progress.length === 0) {
        progEl.innerHTML = '<div class="no-data">Недостаточно данных за два периода по 30 дней</div>';
    } else {
        progEl.innerHTML = progress.map(function(p) {
            var sign = p.gain > 0 ? '+' : '';
            var cls = p.gain > 0 ? 'stats-progress-up' : (p.gain < 0 ? 'stats-progress-down' : 'stats-progress-flat');
            var arrow = p.gain > 0 ? '▲' : (p.gain < 0 ? '▼' : '◆');
            return '<div class="stats-progress-row">' +
                '<div class="stats-progress-name">' + p.name + '</div>' +
                '<div class="stats-progress-values">' +
                    '<span class="stats-progress-prev">' + p.prev + ' кг</span> → ' +
                    '<strong>' + p.recent + ' кг</strong>' +
                '</div>' +
                '<div class="stats-progress-gain ' + cls + '">' + arrow + ' ' + sign + p.gain.toFixed(1) + ' кг</div>' +
            '</div>';
        }).join('');
    }
}

// ========== ВКЛАДКА «ЗАМЕТКИ» (Фаза 4) ==========

var notesLoadedFor = '';
var profileLoadedFor = '';

async function loadClientNotes(clientName) {
    if (!clientName) return;
    var list = document.getElementById('notes-list');
    if (!list) return;
    if (notesLoadedFor === clientName) return; // уже загружено
    list.innerHTML = '<div class="no-data">Загрузка заметок...</div>';
    try {
        var url = APPS_SCRIPT_URL + '?action=getClientNotes&clientName=' + encodeURIComponent(clientName);
        var resp = await fetch(url);
        var data = await resp.json();
        if (data.error) {
            list.innerHTML = '<div class="no-data">Ошибка: ' + data.error + '</div>';
            return;
        }
        notesLoadedFor = clientName;
        renderNotesList(data.notes || []);
    } catch (e) {
        list.innerHTML = '<div class="no-data">Ошибка загрузки</div>';
    }
}

function renderNotesList(notes) {
    var list = document.getElementById('notes-list');
    if (!list) return;
    if (!notes || notes.length === 0) {
        list.innerHTML = '<div class="no-data">Пока нет заметок</div>';
        return;
    }
    list.innerHTML = notes.map(function(n) {
        var flag = n.important ? '<span class="notes-flag">⚠️</span>' : '';
        var safeName = (currentClientCard ? currentClientCard.name : '').replace(/'/g, "\\'");
        var text = (n.text || '').replace(/</g, '&lt;').replace(/\n/g, '<br>');
        return '<div class="notes-item' + (n.important ? ' notes-item-important' : '') + '">' +
            '<div class="notes-item-head">' +
                '<span class="notes-item-date">📅 ' + n.date + '</span>' +
                flag +
                '<button class="notes-item-del" onclick="deleteClientNoteFlow(' + n.ts + ')" title="Удалить">🗑</button>' +
            '</div>' +
            '<div class="notes-item-text">' + text + '</div>' +
        '</div>';
    }).join('');
}

async function saveNewNote() {
    if (!currentClientCard) return;
    var textEl = document.getElementById('notes-new-text');
    var impEl = document.getElementById('notes-new-important');
    var text = (textEl.value || '').trim();
    if (!text) {
        tg.showAlert('Напиши текст заметки');
        return;
    }
    try {
        var url = APPS_SCRIPT_URL + '?action=addClientNote' +
            '&clientName=' + encodeURIComponent(currentClientCard.name) +
            '&text=' + encodeURIComponent(text) +
            '&important=' + (impEl.checked ? 'true' : 'false');
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        textEl.value = '';
        impEl.checked = false;
        notesLoadedFor = ''; // сброс кэша, перезагрузим
        await loadClientNotes(currentClientCard.name);
    } catch (e) {
        console.error('Save note error:', e);
        tg.showAlert('Ошибка соединения ❌');
    }
}

async function deleteClientNoteFlow(ts) {
    if (!currentClientCard || !ts) return;
    var confirmed = await tgConfirm('Удалить заметку?');
    if (!confirmed) return;
    try {
        var url = APPS_SCRIPT_URL + '?action=deleteClientNote' +
            '&clientName=' + encodeURIComponent(currentClientCard.name) +
            '&ts=' + ts;
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        notesLoadedFor = '';
        await loadClientNotes(currentClientCard.name);
    } catch (e) {
        tg.showAlert('Ошибка соединения ❌');
    }
}

// ── Анкета клиента ──

async function loadClientProfile(chatId) {
    if (!chatId) return;
    var chatIdField = document.getElementById('prof-chatid');
    if (chatIdField) chatIdField.value = chatId;
    if (profileLoadedFor === chatId) return;
    try {
        var url = APPS_SCRIPT_URL + '?action=getClientProfile&targetChatId=' + encodeURIComponent(chatId);
        var resp = await fetch(url);
        var data = await resp.json();
        if (data.error) return;
        profileLoadedFor = chatId;
        fillProfileForm(data);
    } catch (e) { console.error('Load profile error:', e); }
}

function fillProfileForm(p) {
    // Пол
    document.querySelectorAll('input[name="prof-gender"]').forEach(function(el) {
        el.checked = (el.value === p.gender);
    });
    document.getElementById('prof-age').value = p.age || '';
    document.getElementById('prof-height').value = p.height || '';
    document.getElementById('prof-weight').value = p.weight || '';
    document.getElementById('prof-goal').value = p.goal || '';
    document.getElementById('prof-level').value = p.level || '';
    document.getElementById('prof-frequency').value = p.frequency || '';
    document.getElementById('prof-inventory').value = p.inventory || '';

    // Ограничения: CSV в hidden, чекбоксы для стандартных + free-text «Другое»
    var lim = (p.limitations || '').toString();
    var known = ['knee', 'back', 'shoulder', 'wrist'];
    var arr = lim.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    var other = [];
    document.querySelectorAll('.prof-limit-cb').forEach(function(cb) {
        cb.checked = arr.indexOf(cb.value) >= 0;
    });
    arr.forEach(function(v) { if (known.indexOf(v) < 0) other.push(v); });
    document.getElementById('prof-limit-other').value = other.join(', ');
}

function collectProfileForm() {
    var gender = '';
    var g = document.querySelector('input[name="prof-gender"]:checked');
    if (g) gender = g.value;

    var limits = [];
    document.querySelectorAll('.prof-limit-cb').forEach(function(cb) {
        if (cb.checked) limits.push(cb.value);
    });
    var other = (document.getElementById('prof-limit-other').value || '').trim();
    if (other) other.split(',').forEach(function(s) {
        var v = s.trim();
        if (v) limits.push(v);
    });

    return {
        gender: gender,
        age: document.getElementById('prof-age').value.trim(),
        height: document.getElementById('prof-height').value.trim(),
        weight: document.getElementById('prof-weight').value.trim(),
        goal: document.getElementById('prof-goal').value,
        level: document.getElementById('prof-level').value,
        frequency: document.getElementById('prof-frequency').value,
        limitations: limits.join(','),
        inventory: document.getElementById('prof-inventory').value
    };
}

async function saveClientProfile() {
    if (!currentClientCard) return;
    var fields = collectProfileForm();
    var qs = 'action=updateClientProfile&targetChatId=' + encodeURIComponent(currentClientCard.chatId);
    Object.keys(fields).forEach(function(k) {
        qs += '&' + k + '=' + encodeURIComponent(fields[k]);
    });
    try {
        var resp = await fetch(APPS_SCRIPT_URL + '?' + qs);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        tg.showAlert('✅ Анкета сохранена');
    } catch (e) {
        tg.showAlert('Ошибка соединения ❌');
    }
}

async function saveClientChatId() {
    if (!currentClientCard) return;
    var input = document.getElementById('prof-chatid');
    var newChatId = (input.value || '').trim();
    if (!newChatId || newChatId === currentClientCard.chatId) return;
    var ok = await tgConfirm(
        'Поменять ID клиента с ' + currentClientCard.chatId + ' на ' + newChatId + '? ' +
        'Если ошибёшься — клиент потеряет доступ к боту/мини-аппу.'
    );
    if (!ok) { input.value = currentClientCard.chatId; return; }
    try {
        var url = APPS_SCRIPT_URL + '?action=renameClientChatId&oldChatId=' +
            encodeURIComponent(currentClientCard.chatId) + '&newChatId=' + encodeURIComponent(newChatId);
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        currentClientCard.chatId = newChatId;
        profileLoadedFor = null; // чтобы следующий заход в анкету перечитал данные по новому id
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        tg.showAlert('✅ ID обновлён');
        loadAdminClients();
    } catch (e) {
        tg.showAlert('Ошибка соединения ❌');
    }
}

// ========== ИСТОРИЯ ПО КОНКРЕТНОМУ УПРАЖНЕНИЮ ==========

var exStatChart = null;
var exStatSelectedName = '';

// Собирает уникальный список упражнений из текущей истории клиента (по очищенным именам)
function _getUniqueExercisesFromHistory(history) {
    var seen = {};
    var list = [];
    (history || []).forEach(function(day) {
        (day.exercises || []).forEach(function(ex) {
            var name = cleanExerciseName(ex.exercise);
            if (!name) return;
            if (seen[name]) return;
            seen[name] = true;
            list.push(name);
        });
    });
    list.sort(function(a, b) { return a.localeCompare(b, 'ru'); });
    return list;
}

// Собирает массив попыток (только с фактом) для конкретного упражнения, отсортированных по дате (по возрастанию для графика)
function _collectExerciseAttempts(history, exerciseName) {
    var target = cleanExerciseName(exerciseName);
    var attempts = [];
    (history || []).forEach(function(day) {
        (day.exercises || []).forEach(function(ex) {
            if (cleanExerciseName(ex.exercise) !== target) return;
            var wFact = parseFloat(ex.weightFact);
            var rFact = parseFloat(ex.repsFact);
            // Без факта неинтересно (план не делал)
            if (isNaN(wFact) && isNaN(rFact)) return;
            attempts.push({
                date: day.date,
                dateObj: day.dateObj,
                weightFact: isNaN(wFact) ? null : wFact,
                repsFact: isNaN(rFact) ? null : rFact,
                rpe: ex.rpe || '',
                feedback: ex.feedback || null,
                comment: ex.comment || '',
                weightPlan: ex.weightPlan || '',
                reps: ex.reps || ''
            });
        });
    });
    attempts.sort(function(a, b) { return a.dateObj - b.dateObj; });
    return attempts;
}

function openExerciseStats() {
    if (!currentClientCard) return;
    var history = clientHistoryCache[currentClientCard.name] || [];
    if (history.length === 0) {
        tg.showAlert('Сначала открой вкладку «История» — нужно загрузить данные');
        return;
    }

    document.getElementById('ex-stat-client-name').textContent = currentClientCard.name;
    document.body.classList.add('no-scroll');
    document.getElementById('ex-stat-modal').classList.remove('hidden');

    var list = _getUniqueExercisesFromHistory(history);
    var sel = document.getElementById('ex-stat-select');
    sel.innerHTML = list.map(function(name) {
        return '<option value="' + name.replace(/"/g, '&quot;') + '">' + name + '</option>';
    }).join('');

    // Выбираем первое (или ранее выбранное, если осталось в списке)
    if (exStatSelectedName && list.indexOf(exStatSelectedName) >= 0) {
        sel.value = exStatSelectedName;
    } else if (list.length > 0) {
        sel.value = list[0];
        exStatSelectedName = list[0];
    }

    // Навешиваем обработчик один раз
    if (!sel.dataset.bound) {
        sel.addEventListener('change', function() {
            exStatSelectedName = sel.value;
            renderExerciseStats(currentClientCard.name, sel.value);
        });
        sel.dataset.bound = '1';
    }

    if (exStatSelectedName) renderExerciseStats(currentClientCard.name, exStatSelectedName);
}

function closeExerciseStats() {
    document.getElementById('ex-stat-modal').classList.add('hidden');
    document.body.classList.remove('no-scroll');
    if (exStatChart) {
        try { exStatChart.destroy(); } catch (_) {}
        exStatChart = null;
    }
}

function renderExerciseStats(clientName, exerciseName) {
    var history = clientHistoryCache[clientName] || [];
    var attempts = _collectExerciseAttempts(history, exerciseName);

    // ── Личный рекорд ──
    var prEl = document.getElementById('ex-stat-pr');
    if (attempts.length === 0) {
        prEl.innerHTML = '🏆 Личный рекорд: <span class="ex-stat-empty">нет данных</span>';
    } else {
        var pr = attempts.reduce(function(acc, a) {
            if (acc == null) return a;
            if ((a.weightFact || 0) > (acc.weightFact || 0)) return a;
            // При равном весе — больше повторов лучше
            if ((a.weightFact || 0) === (acc.weightFact || 0) && (a.repsFact || 0) > (acc.repsFact || 0)) return a;
            return acc;
        }, null);
        var repsTxt = pr.repsFact ? ' × ' + pr.repsFact : '';
        prEl.innerHTML = '🏆 Личный рекорд: <strong>' + (pr.weightFact != null ? pr.weightFact + ' кг' : '—') + repsTxt + '</strong> <span class="ex-stat-pr-date">(' + pr.date + ')</span>';
    }

    // ── График ──
    var canvas = document.getElementById('ex-stat-chart');
    if (exStatChart) {
        try { exStatChart.destroy(); } catch (_) {}
        exStatChart = null;
    }
    if (attempts.length === 0) {
        canvas.style.display = 'none';
    } else {
        canvas.style.display = '';
        var ctx = canvas.getContext('2d');
        var labels = attempts.map(function(a) {
            // Короткая дата dd.MM
            var p = (a.date || '').split('.');
            return p.length >= 2 ? p[0] + '.' + p[1] : a.date;
        });
        var weights = attempts.map(function(a) { return a.weightFact; });

        // Цвета точек по фидбэку
        var pointColors = attempts.map(function(a) {
            if (a.feedback && a.feedback.code) {
                if (a.feedback.code === 'easy')   return '#43A047';
                if (a.feedback.code === 'normal') return '#1565C0';
                if (a.feedback.code === 'hard')   return '#E65100';
                if (a.feedback.code === 'failed') return '#C62828';
            }
            return '#1a1a2e';
        });

        exStatChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Вес, кг',
                    data: weights,
                    borderColor: '#1a1a2e',
                    backgroundColor: 'rgba(26,26,46,0.08)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 6,
                    pointBackgroundColor: pointColors,
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
                        backgroundColor: '#1a1a2e',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        padding: 10,
                        cornerRadius: 8,
                        displayColors: false,
                        callbacks: {
                            label: function(ctx2) {
                                var i = ctx2.dataIndex;
                                var a = attempts[i];
                                var parts = [];
                                if (a.weightFact != null) parts.push(a.weightFact + ' кг');
                                if (a.repsFact != null) parts.push(a.repsFact + ' повт');
                                if (a.rpe) parts.push('RPE ' + a.rpe);
                                if (a.feedback) parts.push(a.feedback.emoji + ' ' + a.feedback.label);
                                return parts.join(' · ');
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: false,
                        ticks: { callback: function(v) { return v + ' кг'; } },
                        grid: { color: '#f0f0f0' }
                    },
                    x: { grid: { display: false } }
                }
            }
        });
    }

    // ── Таблица ──
    var table = document.getElementById('ex-stat-table');
    if (attempts.length === 0) {
        table.innerHTML = '<div class="no-data">Нет фактических попыток</div>';
        return;
    }
    // В таблице — по убыванию даты (свежие сверху)
    var rev = attempts.slice().reverse();
    table.innerHTML = rev.map(function(a) {
        var fb = a.feedback
            ? '<span class="hh-ex-feedback hh-fb-' + a.feedback.code + '">' + a.feedback.emoji + ' ' + a.feedback.label + '</span>'
            : '';
        var repsTxt = a.repsFact != null ? ' × ' + a.repsFact : '';
        var rpeTxt = a.rpe ? ' · RPE ' + a.rpe : '';
        return '<div class="ex-stat-row">' +
            '<div class="ex-stat-row-date">' + a.date + '</div>' +
            '<div class="ex-stat-row-value">' +
                '<strong>' + (a.weightFact != null ? a.weightFact + ' кг' : '—') + repsTxt + '</strong>' +
                '<span class="ex-stat-row-rpe">' + rpeTxt + '</span>' +
            '</div>' +
            fb +
        '</div>';
    }).join('');
}

// ========== РЕДАКТОР УПРАЖНЕНИЯ (Фаза 2B + 2C) ==========

var currentEditingRow = null;
var currentEditingMode = 'edit'; // 'edit' | 'add'
var currentAddDay = '';          // используется в режиме 'add'
var currentEditingPrefix = '';   // 'СЕТ: ' / 'ТРИСЕТ: ' / '' — чтобы не потерять при сохранении
var currentSetType = 'single';   // 'single' | 'superset' | 'triset' (только в режиме add)

// Очередь несохранённых правок упражнений: { rowIndex: paramsForApi }
// Когда тренер редактирует упражнения через модалку — изменения не уходят сразу в Google Sheets,
// а копятся здесь. Финальный коммит делает кнопка «💾 Сохранить изменения» внизу программы.
var pendingExerciseEdits = {};
var activeNameInputId = 'ex-edit-name'; // какое поле «Название» сейчас активно для библиотеки

function openExerciseEditor(rowIndex) {
    var ex = currentProgramExercisesByRow[rowIndex];
    if (!ex || !currentClientCard) return;
    currentEditingRow = rowIndex;
    currentEditingMode = 'edit';
    currentAddDay = '';
    currentSetType = 'single';

    // Запоминаем префикс «СЕТ:»/«ТРИСЕТ:» — чтобы при сохранении не разрушить связку
    var rawName = (ex.exercise || '').toString();
    if (/^\s*трисет\s*:/i.test(rawName)) currentEditingPrefix = 'ТРИСЕТ: ';
    else if (/^\s*сет\s*:/i.test(rawName)) currentEditingPrefix = 'СЕТ: ';
    else currentEditingPrefix = '';

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
    if (saveBtn) saveBtn.textContent = '✅ Применить';

    // Подсказка «Последний раз» — сначала покажем из текущей программы, потом обогатим данными из истории
    showLastResultHint({
        weightFact: ex.weightFact,
        repsFact: ex.repsFact,
        rpe: ex.rpe,
        date: '' // в текущей программе нет даты
    });
    // Параллельно запрашиваем самое свежее из истории (если упражнение не пустое)
    loadAndShowLastResult(cleanExerciseName(ex.exercise));

    document.getElementById('ex-editor-modal').classList.remove('hidden');

    // Готовим библиотеку и сбрасываем фильтр на "Этот день"
    libraryFilterMuscle = 'day';
    librarySearchText = '';
    closeExerciseLibrary();
    loadExerciseLibrary(); // фоном — потом откроется быстро по фокусу
}

// Показать подсказку «Последний раз» с переданными значениями
function showLastResultHint(data) {
    var hint = document.getElementById('ex-edit-history-hint');
    if (!hint) return;
    var w = data.weightFact, r = data.repsFact, rpe = data.rpe;
    var hasFact = (w !== '' && w != null && w !== 0) || (r !== '' && r != null && r !== 0);
    if (!hasFact) {
        hint.textContent = '';
        hint.classList.add('hidden');
        return;
    }
    var parts = [];
    if (w) parts.push(w + ' кг');
    if (r) parts.push('× ' + r);
    if (rpe) parts.push('RPE ' + rpe);
    if (data.feedback && data.feedback.label) {
        parts.push(data.feedback.emoji + ' ' + data.feedback.label);
    }
    var dateTxt = data.date ? ' (' + data.date + ')' : '';
    hint.classList.remove('hidden');
    hint.classList.remove('ex-hint-empty');
    hint.classList.remove('ex-hint-loading');
    hint.innerHTML = '💪 Последний раз: <strong>' + parts.join(' · ') + '</strong>' + dateTxt;
}

// Сообщение «Это упражнение клиент ещё не выполнял»
function showLastResultEmpty() {
    var hint = document.getElementById('ex-edit-history-hint');
    if (!hint) return;
    hint.classList.remove('hidden');
    hint.classList.remove('ex-hint-loading');
    hint.classList.add('ex-hint-empty');
    hint.textContent = 'ℹ️ Это упражнение клиент ещё не выполнял';
}

function showLastResultLoading() {
    var hint = document.getElementById('ex-edit-history-hint');
    if (!hint) return;
    hint.classList.remove('hidden');
    hint.classList.remove('ex-hint-empty');
    hint.classList.add('ex-hint-loading');
    hint.textContent = '⏳ Ищу последний результат…';
}

// Кэш: clientName||exerciseName → result | 'empty'
var lastResultCache = {};
var lastResultDebounceTimer = null;

// Главная функция: подгружает и показывает последний результат клиента по упражнению.
// Вызывается при открытии редактора, при выборе из библиотеки, при ручном вводе названия.
function loadAndShowLastResult(exerciseName) {
    if (!currentClientCard) return;
    var name = (exerciseName || '').toString().trim();
    var hint = document.getElementById('ex-edit-history-hint');
    if (!name) {
        hint.textContent = '';
        hint.classList.add('hidden');
        return;
    }
    var key = currentClientCard.name + '||' + name;
    if (lastResultCache[key] !== undefined) {
        var cached = lastResultCache[key];
        if (cached === 'empty') showLastResultEmpty();
        else showLastResultHint(cached);
        return;
    }

    showLastResultLoading();
    if (lastResultDebounceTimer) clearTimeout(lastResultDebounceTimer);
    lastResultDebounceTimer = setTimeout(function() {
        var url = APPS_SCRIPT_URL + '?action=getLastExerciseResult' +
            '&clientName=' + encodeURIComponent(currentClientCard.name) +
            '&exerciseName=' + encodeURIComponent(name);
        fetch(url).then(function(r) { return r.json(); }).then(function(data) {
            if (data && !data.empty && !data.error) {
                lastResultCache[key] = {
                    weightFact: data.weightFact,
                    repsFact: data.repsFact,
                    rpe: data.rpe,
                    feedback: data.feedback,
                    date: data.date
                };
                showLastResultHint(lastResultCache[key]);
            } else {
                lastResultCache[key] = 'empty';
                showLastResultEmpty();
            }
        }).catch(function() {
            // Тихо — оставляем как есть
            hint.classList.add('hidden');
        });
    }, 280);
}

// Открыть модалку для ДОБАВЛЕНИЯ нового упражнения / суперсета / трисета в указанный день
function openAddExerciseModal(dayName) {
    if (!currentClientCard) return;
    currentEditingRow = null;
    currentEditingMode = 'add';
    currentAddDay = dayName || '';
    currentSetType = 'single';
    currentEditingPrefix = '';

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

    // Скрываем кнопку «Удалить» и подсказку фактов (имя пустое — нечего показывать)
    var delBtn = document.getElementById('ex-edit-delete-btn');
    if (delBtn) delBtn.classList.add('hidden');
    var saveBtn = document.getElementById('ex-edit-save-btn');
    if (saveBtn) saveBtn.textContent = '➕ Добавить';
    var hint = document.getElementById('ex-edit-history-hint');
    hint.textContent = '';
    hint.classList.add('hidden');
    hint.classList.remove('ex-hint-empty', 'ex-hint-loading');

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

    var nameVal = document.getElementById('ex-edit-name').value.trim();
    if (!nameVal) {
        tg.showAlert('Укажи название упражнения');
        return;
    }

    // ── РЕЖИМ ДОБАВЛЕНИЯ — оставляем как было, сразу сохраняем и перегружаем программу ──
    if (currentEditingMode === 'add') {
        saveBtn.disabled = true;
        saveBtn.textContent = '⏳ Сохранение...';

        var params = {
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

        // Если есть несохранённые правки — сначала сливаем их, иначе порядковые rowIndex'ы могут уехать
        if (Object.keys(pendingExerciseEdits).length > 0) {
            saveBtn.textContent = '⏳ Сохраняю прошлые изменения...';
            var flushOk = await flushPendingExerciseEdits();
            if (!flushOk) {
                tg.showAlert('Не удалось сохранить прошлые изменения — добавление отменено.');
                saveBtn.disabled = false;
                saveBtn.textContent = origText;
                return;
            }
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
            saveBtn.textContent = '✅ Добавлено';
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
        return;
    }

    // ── РЕЖИМ РЕДАКТИРОВАНИЯ — кладём в очередь, не дёргаем API ──
    if (!currentEditingRow) return;
    // Восстанавливаем префикс «СЕТ:»/«ТРИСЕТ:» если упражнение было частью связки
    var nameWithPrefix = currentEditingPrefix ? (currentEditingPrefix + nameVal) : nameVal;
    var editParams = {
        action: 'updateClientExercise',
        sheetName: currentClientCard.sheetName,
        rowIndex: currentEditingRow,
        exercise: nameWithPrefix,
        weightPlan: document.getElementById('ex-edit-weight').value.trim(),
        reps: document.getElementById('ex-edit-reps').value.trim(),
        sets: document.getElementById('ex-edit-sets').value.trim(),
        rpe: document.getElementById('ex-edit-rpe').value.trim(),
        note: document.getElementById('ex-edit-note').value.trim()
    };

    // 1. Запоминаем правку в очередь (overwrite если ту же строку уже редактировали)
    pendingExerciseEdits[currentEditingRow] = editParams;

    // 2. Обновляем DOM оптимистично — клиент видит новые значения сразу
    updateExerciseInDOM(currentEditingRow, editParams);

    // 3. Обновляем кэш чтоб при повторном открытии модалки были свежие данные
    var cached = currentProgramExercisesByRow[currentEditingRow];
    if (cached) {
        cached.exercise = editParams.exercise;
        cached.weightPlan = editParams.weightPlan;
        cached.reps = editParams.reps;
        cached.sets = editParams.sets;
        cached.rpe = editParams.rpe;
        cached.note = editParams.note;
    }

    // 4. Помечаем строку как «есть несохранённое изменение»
    markExerciseDirty(currentEditingRow);

    // 5. Показываем/обновляем плавающую кнопку «Сохранить изменения (N)»
    updateBulkSaveBar();

    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    closeExerciseEditor();
}


// Поставить визуальную метку «есть несохранённое изменение» на строку упражнения
function markExerciseDirty(rowIndex) {
    if (!rowIndex) return;
    var editBtn = document.querySelector('.cc-ex-edit-btn[onclick*="openExerciseEditor(' + rowIndex + ')"]');
    if (!editBtn) return;
    var row = editBtn.closest('.cc-ex-row');
    if (row) row.classList.add('cc-ex-pending');
}

function unmarkExerciseDirty(rowIndex) {
    if (!rowIndex) return;
    var editBtn = document.querySelector('.cc-ex-edit-btn[onclick*="openExerciseEditor(' + rowIndex + ')"]');
    if (!editBtn) return;
    var row = editBtn.closest('.cc-ex-row');
    if (row) row.classList.remove('cc-ex-pending');
}

// Показать/скрыть плавающую кнопку «Сохранить изменения», обновить счётчик
function updateBulkSaveBar() {
    var bar = document.getElementById('cc-bulk-save-bar');
    if (!bar) return;
    var count = Object.keys(pendingExerciseEdits).length;
    var btn = document.getElementById('cc-bulk-save-btn');
    if (count === 0) {
        bar.classList.add('hidden');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '💾 Сохранить изменения';
        }
        return;
    }
    bar.classList.remove('hidden');
    if (btn && !btn.disabled) {
        btn.innerHTML = '💾 Сохранить изменения (' + count + ')';
    }
}

// Сохранить все накопленные правки одним проходом (вызывается из плавающей кнопки)
async function saveAllPendingEdits() {
    var keys = Object.keys(pendingExerciseEdits);
    if (keys.length === 0) return;
    var btn = document.getElementById('cc-bulk-save-btn');
    if (!btn) return;
    btn.disabled = true;

    var total = keys.length;
    var saved = 0, failed = 0;
    for (var i = 0; i < keys.length; i++) {
        var rowIdx = keys[i];
        var params = pendingExerciseEdits[rowIdx];
        btn.innerHTML = '⏳ Сохранение ' + (i + 1) + '/' + total + '...';
        try {
            var query = Object.keys(params).map(function(k) {
                return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
            }).join('&');
            var resp = await fetch(APPS_SCRIPT_URL + '?' + query);
            var data = await resp.json();
            if (data.success) {
                saved++;
                delete pendingExerciseEdits[rowIdx];
                unmarkExerciseDirty(rowIdx);
            } else {
                failed++;
                console.error('Bulk save failed for row ' + rowIdx, data.error);
            }
        } catch (err) {
            failed++;
            console.error('Bulk save network error for row ' + rowIdx, err);
        }
    }

    if (failed === 0) {
        btn.innerHTML = '✅ Сохранено!';
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        setTimeout(function() {
            updateBulkSaveBar();
        }, 1200);
    } else {
        tg.showAlert('Сохранено: ' + saved + '\nОшибок: ' + failed + '\n\nНеудачные правки остались в очереди — попробуй сохранить ещё раз.');
        btn.disabled = false;
        updateBulkSaveBar();
    }
}

// Утилита: синхронно дождаться сохранения очереди (используется перед add/delete/reload).
// Возвращает true если очередь пустая или всё сохранилось без ошибок.
async function flushPendingExerciseEdits() {
    if (Object.keys(pendingExerciseEdits).length === 0) return true;
    await saveAllPendingEdits();
    return Object.keys(pendingExerciseEdits).length === 0;
}

// Сбросить очередь (например при закрытии карточки без сохранения)
function discardPendingExerciseEdits() {
    var keys = Object.keys(pendingExerciseEdits);
    keys.forEach(function(k) { unmarkExerciseDirty(k); });
    pendingExerciseEdits = {};
    updateBulkSaveBar();
}

async function deleteExerciseEdit() {
    if (!currentEditingRow || !currentClientCard) return;
    var ex = currentProgramExercisesByRow[currentEditingRow];
    var name = ex ? cleanExerciseName(ex.exercise) : 'упражнение';
    var confirmed = await tgConfirm('Удалить «' + name + '» из программы?');
    if (!confirmed) return;

    var delBtn = document.getElementById('ex-edit-delete-btn');
    var origText = delBtn.textContent;
    delBtn.disabled = true;
    delBtn.textContent = '⏳ Удаление...';

    // Удаление сдвигает rowIndex'ы — сначала сливаем все накопленные правки,
    // иначе они применятся не к тем упражнениям.
    if (Object.keys(pendingExerciseEdits).length > 0) {
        delBtn.textContent = '⏳ Сохраняю прошлые правки...';
        var flushOk = await flushPendingExerciseEdits();
        if (!flushOk) {
            tg.showAlert('Не удалось сохранить прошлые изменения — удаление отменено.');
            delBtn.disabled = false;
            delBtn.textContent = origText;
            return;
        }
        delBtn.textContent = '⏳ Удаление...';
    }

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

// Точечно обновить значения упражнения в DOM без полного перерендера программы.
// fields: { exercise, weightPlan, reps, sets, rpe, note } — все поля как в params для бэка.
function updateExerciseInDOM(rowIndex, fields) {
    if (!rowIndex) return;
    // Находим кнопку ✏️ с этим rowIndex — оттуда поднимаемся к .cc-ex-row
    var editBtn = document.querySelector('.cc-ex-edit-btn[onclick*="openExerciseEditor(' + rowIndex + ')"]');
    if (!editBtn) return;
    var row = editBtn.closest('.cc-ex-row');
    if (!row) return;

    // ── Имя ──
    if (fields.exercise !== undefined) {
        var nameEl = row.querySelector('.cc-ex-name');
        if (nameEl) {
            // Сохраняем bind-метку A/B/C если есть
            var labelEl = nameEl.querySelector('.cc-ex-suplabel');
            var labelHtml = labelEl ? labelEl.outerHTML : '';
            nameEl.innerHTML = labelHtml + cleanExerciseName(fields.exercise);
        }
    }

    // ── Ячейки Вес / Повт. / Подх. / RPE ──
    var cells = row.querySelectorAll('.cc-ex-cell .cc-cell-value');
    if (cells.length >= 4) {
        if (fields.weightPlan !== undefined) {
            var v = fields.weightPlan;
            cells[0].textContent = (v !== '' && v != null ? v : '—') + ' кг';
        }
        if (fields.reps !== undefined) {
            cells[1].textContent = (fields.reps !== '' && fields.reps != null) ? fields.reps : '—';
        }
        if (fields.sets !== undefined) {
            cells[2].textContent = (fields.sets !== '' && fields.sets != null) ? fields.sets : '—';
        }
        if (fields.rpe !== undefined) {
            cells[3].textContent = (fields.rpe !== '' && fields.rpe != null) ? fields.rpe : '—';
        }
    }

    // ── Заметка ──
    if (fields.note !== undefined) {
        var existingNote = row.querySelector('.cc-ex-note');
        var noteText = (fields.note || '').toString().trim();
        if (noteText) {
            if (existingNote) {
                existingNote.textContent = noteText;
            } else {
                var noteDiv = document.createElement('div');
                noteDiv.className = 'cc-ex-note';
                noteDiv.textContent = noteText;
                row.appendChild(noteDiv);
            }
        } else if (existingNote) {
            existingNote.remove();
        }
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
            // Для главного поля «Название» (блок A) — обновим подсказку с последним результатом
            if (input.id === 'ex-edit-name') {
                loadAndShowLastResult(input.value);
            }
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
    // Панель библиотеки — один общий элемент на два модальных окна (одиночное
    // упражнение и суперсет/трисет). Физически она живёт внутри #ex-editor-modal;
    // когда открыт #ex-block-modal, тот спрятан (display:none у родителя), и
    // просто снять .hidden с самой панели недостаточно — надо перенести её узел
    // в слот нужной модалки, иначе выпадающий список не будет виден вообще.
    var targetSlot = currentSetType === 'single'
        ? document.querySelector('#ex-editor-modal .ex-editor-body')
        : document.getElementById('ex-block-library-slot');
    if (targetSlot && panel.parentElement !== targetSlot) {
        targetSlot.appendChild(panel);
    }
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
    // После выбора упражнения — подгрузить «Последний раз» (только для главного поля A)
    if (input && input.id === 'ex-edit-name') {
        loadAndShowLastResult(name);
    }
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

    var confirmed = await tgConfirm('Удалить день «' + dayName + '» вместе со всеми упражнениями внутри?');
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

// День недели (один) + группы мышц (несколько) галочками — вместо ручного
// набора текста вида "Пт Грудь-Трицепс". Итоговая строка собирается сама и
// уходит в addClientDay тем же способом, что и раньше.
var ADD_DAY_WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
var addDaySelectedWeekday = '';
var addDaySelectedMuscles = [];

function _capitalizeMuscle(m) {
    return m.charAt(0).toUpperCase() + m.slice(1);
}

function showAddDayDialog() {
    if (!currentClientCard) return;
    addDaySelectedWeekday = '';
    addDaySelectedMuscles = [];

    var weekdayRow = document.getElementById('add-day-weekday-row');
    weekdayRow.innerHTML = ADD_DAY_WEEKDAYS.map(function(d) {
        return '<button type="button" class="add-day-chip" data-day="' + d + '" onclick="selectAddDayWeekday(\'' + d + '\')">' + d + '</button>';
    }).join('');

    var muscleGrid = document.getElementById('add-day-muscle-grid');
    muscleGrid.innerHTML = KNOWN_MUSCLES.map(function(m) {
        return '<button type="button" class="add-day-chip" data-muscle="' + m + '" onclick="toggleAddDayMuscle(\'' + m + '\')">' + _capitalizeMuscle(m) + '</button>';
    }).join('');

    updateAddDayPreview();
    document.getElementById('add-day-modal').classList.remove('hidden');
}

function closeAddDayModal() {
    document.getElementById('add-day-modal').classList.add('hidden');
}

function selectAddDayWeekday(day) {
    addDaySelectedWeekday = day;
    document.querySelectorAll('#add-day-weekday-row .add-day-chip').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.day === day);
    });
    updateAddDayPreview();
}

function toggleAddDayMuscle(muscle) {
    var idx = addDaySelectedMuscles.indexOf(muscle);
    if (idx === -1) addDaySelectedMuscles.push(muscle); else addDaySelectedMuscles.splice(idx, 1);
    document.querySelectorAll('#add-day-muscle-grid .add-day-chip').forEach(function(btn) {
        btn.classList.toggle('active', addDaySelectedMuscles.indexOf(btn.dataset.muscle) !== -1);
    });
    updateAddDayPreview();
}

function updateAddDayPreview() {
    var muscleLabel = addDaySelectedMuscles.map(_capitalizeMuscle).join('-');
    document.getElementById('add-day-preview').value = (addDaySelectedWeekday + ' ' + muscleLabel).trim();
}

async function submitAddDay() {
    if (!currentClientCard) return;
    var dayName = (document.getElementById('add-day-preview').value || '').trim();
    if (!dayName) {
        tg.showAlert('Выбери день недели и хотя бы одну группу мышц (или впиши название вручную в поле выше)');
        return;
    }
    var btn = document.getElementById('add-day-save-btn');
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Добавление...';
    try {
        var url = APPS_SCRIPT_URL + '?action=addClientDay' +
            '&sheetName=' + encodeURIComponent(currentClientCard.sheetName) +
            '&dayName=' + encodeURIComponent(dayName);
        var resp = await fetch(url);
        var data = await resp.json();
        if (!data.success) {
            tg.showAlert('Ошибка: ' + (data.error || 'не удалось'));
            return;
        }
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        closeAddDayModal();
        await loadClientProgram(currentClientCard.sheetName);
    } catch (error) {
        console.error('Add day error:', error);
        tg.showAlert('Ошибка соединения ❌');
    } finally {
        btn.disabled = false;
        btn.textContent = origText;
    }
}

function openBlockModal(dayName, type) {
    currentBlockType = type;
    currentBlockDay = dayName || '';
    // Чтобы библиотека упражнений знала, для какого дня показывать фильтр "Этот день"
    currentEditingMode = 'add';
    currentAddDay = dayName || '';
    currentSetType = type; // 'superset' | 'triset'
    var count = type === 'triset' ? 3 : 2;
    var title = type === 'triset' ? '+ Новый трисет (3 упр.)' : '+ Новый суперсет (2 упр.)';
    document.getElementById('ex-block-title').textContent = title + (dayName ? ' · ' + dayName : '');

    // Рендерим N секций. Каждому полю «Название» даём уникальный id и data-block,
    // чтобы оно подключалось к выпадающему списку упражнений (как в одиночном режиме).
    var html = '';
    for (var i = 0; i < count; i++) {
        var label = String.fromCharCode(65 + i); // A, B, C
        var nameInputId = 'ex-block-name-' + i;
        html +=
            '<div class="ex-block-section" data-block-idx="' + i + '">' +
                '<div class="ex-block-section-title">' + label + ' — упражнение ' + (i + 1) + '</div>' +
                '<div class="ex-editor-field">' +
                    '<label class="ex-editor-label">Название</label>' +
                    '<input type="text" id="' + nameInputId + '" class="ex-editor-input ex-block-name ex-name-field" data-idx="' + i + '" data-block="' + label + '" placeholder="Например: Жим штанги лёжа" autocomplete="off">' +
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

    // Подключаем слушатели к новым полям «Название» — на focus открываем библиотеку
    document.querySelectorAll('#ex-block-body .ex-block-name').forEach(function(input) {
        input.addEventListener('focus', function() {
            activeNameInputId = input.id;
            // Сбрасываем фильтр на «Этот день» при каждом фокусе, чтобы упражнения релевантные дню были видны сразу
            libraryFilterMuscle = 'day';
            openExerciseLibrary();
        });
        input.addEventListener('input', function() {
            activeNameInputId = input.id;
            librarySearchText = (input.value || '').toLowerCase().trim();
            renderLibraryList();
        });
    });

    // Прогреваем библиотеку в фоне, чтобы первый клик открыл её без задержки
    libraryFilterMuscle = 'day';
    closeExerciseLibrary();
    loadExerciseLibrary();
}

function closeBlockModal() {
    document.getElementById('ex-block-modal').classList.add('hidden');
    closeExerciseLibrary();
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
        var chatId = _myChatId();
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
            '<div class="latest-card-date">' + formatDate(latest.date) + '</div>' +
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

    // Фото прогресса — сжимаем в браузере и показываем превью, как в редакторе упражнений
    document.getElementById('meas-photo-file').addEventListener('change', function(e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        _compressImageFile(file, 1280, 0.82, function(result) {
            measPhotoPending = result;
            var preview = document.getElementById('meas-photo-preview');
            preview.innerHTML = '<img src="data:' + result.mime + ';base64,' + result.base64 + '">';
            preview.classList.remove('hidden');
        }, function(errMsg) {
            e.target.value = '';
            measPhotoPending = null;
            tg.showAlert('❌ ' + errMsg);
        });
    });
}

var measPhotoPending = null;

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

    // Check at least one field filled (фото само по себе тоже считается записью)
    var hasAny = Object.values(fields).some(function(v) { return v && v.trim() !== ''; }) || !!measPhotoPending;
    if (!hasAny) {
        tg.showAlert('Заполни хотя бы одно поле или прикрепи фото! 📏');
        return;
    }

    btn.textContent = '⏳ Сохранение...';
    btn.classList.add('saving');
    btn.disabled = true;

    try {
        var chatId = _myChatId();
        var payload = Object.assign({}, fields);
        if (measPhotoPending) {
            payload.photoBase64 = measPhotoPending.base64;
            payload.photoMime = measPhotoPending.mime;
        }
        var url = APPS_SCRIPT_URL + '?action=saveMeasurements&chatId=' + chatId;
        // Без явного Content-Type: application/json — иначе браузер шлёт CORS
        // preflight (OPTIONS), а Apps Script его не обрабатывает и запрос падает
        // с "Failed to fetch". Без заголовка тело уходит как text/plain (что для
        // CORS считается "простым" запросом), а doPost всё равно парсит его как
        // JSON — тем же способом уже работает saveExerciseMedia.
        var response = await fetch(url, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
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
            measPhotoPending = null;
            document.getElementById('meas-photo-file').value = '';
            var preview = document.getElementById('meas-photo-preview');
            preview.innerHTML = '';
            preview.classList.add('hidden');
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
            labels: filtered.map(function(m) { return formatDate(m.date); }),
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
        var photoHtml = m.photoUrl
            ? '<img class="measurement-row-photo" src="' + m.photoUrl + '" onclick="tg.openLink(\'' + m.photoUrl + '\')">'
            : '';
        return '<div class="measurement-row" style="animation-delay:' + (i * 0.05) + 's">' +
            '<div class="measurement-row-date">📅 ' + formatDate(m.date) + '</div>' +
            photoHtml +
            '<div class="measurement-row-values">' + values + '</div>' +
        '</div>';
    }).join('');
}

function messageClient(chatId, name) {
    var msg = prompt('Сообщение для ' + name + ':');
    if (!msg || !msg.trim()) return;
    var text = '💬 Сообщение от тренера:\n\n' + msg;
    fetch(APPS_SCRIPT_URL + '?action=notifyClient&targetChatId=' + encodeURIComponent(chatId) + '&message=' + encodeURIComponent(text))
        .then(function(resp) { return resp.json(); })
        .then(function(data) {
            if (data.success) tg.showAlert('Сообщение отправлено! ✅');
            else tg.showAlert('Ошибка отправки ❌');
        }).catch(function() { tg.showAlert('Ошибка отправки ❌'); });
}
 