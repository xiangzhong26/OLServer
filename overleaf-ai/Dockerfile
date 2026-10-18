ARG BASE_IMAGE=sharelatex/sharelatex@sha256:eb8c3156339a8f292dc5d087c2add45d7a30b4d9e387d6c4fdf612ecc079ad6f
FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.title="Overleaf with DeepSeek AI" \
      org.opencontainers.image.description="Overleaf 6.3.1 with inline DeepSeek completion and selection editing"

COPY overlay/ /overleaf/

RUN cd /overleaf \
    && yarn install --immutable --mode=skip-build \
    && cd /overleaf/services/web \
    && yarn run precompile-pug \
    && yarn run webpack:production
