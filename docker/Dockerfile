# Образ для прогона тестов.
#
# Зависимости здесь НЕ устанавливаются — это делает entrypoint при старте контейнера.
# Так образ не приходится пересобирать после каждой правки package.json, а разработчик
# всегда получает состояние, соответствующее текущему yarn.lock.
#
# Платой за это становится установка на каждом запуске, поэтому node_modules и кэш yarn
# вынесены в именованные тома (см. compose.yaml): при неизменном lock-файле повторный
# `yarn install` занимает секунды.

# Базовый образ — на Debian trixie, а не bookworm.
#
# Причина конкретная: готовые бинарники нативных драйверов для linux-x64 собраны под
# GLIBC 2.38, а в bookworm только 2.36 — загрузка падала с «version `GLIBC_2.38' not found».
# Trixie даёт 2.41, и prebuilt подходит без пересборки.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-trixie-slim

# Нативные модули в зависимостях: better-sqlite3, а также драйверы pg и mysql2. Для linux/amd64
# скачиваются готовые сборки, но на других платформах (например arm64) их может не быть —
# тогда node-gyp собирает из исходников, и нужны компилятор с python.
#
# ca-certificates нужен yarn для обращения к реестру, git — пакетам, ссылающимся на
# репозитории; оба почти всегда требуются и без них падение выглядит неочевидно.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        g++ \
        git \
        make \
        python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Точки монтирования именованных томов создаются заранее.
#
# Docker при первом создании тома копирует владельца и права с этого пути в образе.
# Без подготовки том достаётся root, а контейнер работает не от root — и `yarn install`
# падает на `EACCES: permission denied, mkdir '/home/node/.cache/yarn/v6'`.
#
# Права 1777 (как у /tmp), а не 755 у node: uid процесса задаётся снаружи через `user:`
# в compose.yaml, и у разработчика он может быть не 1000. Sticky-бит не даёт удалять
# чужие файлы, а сами тома — расходный кэш сборки, ничего чувствительного в них нет.
RUN mkdir -p /app/node_modules /home/node/.cache/yarn \
    && chown -R node:node /app /home/node/.cache \
    && chmod 1777 /app/node_modules /home/node/.cache/yarn

# Прогон идёт от пользователя node (uid 1000) — он совпадает с типичным uid разработчика
# в Linux, поэтому файлы, созданные в смонтированном каталоге (coverage, build), остаются
# доступными на хосте. Под другим uid его можно переопределить: см. `user:` в compose.yaml.
USER node

COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Команда по умолчанию: полный прогон проверок, как в CI.
CMD ["yarn", "verify"]
