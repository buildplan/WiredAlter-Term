# Use Node.js 25 on Debian 13
FROM node:25.6.0-trixie-slim

# Install Runtime Dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init gosu git openssh-client vim nano curl wget unzip \
    htop ca-certificates iputils-ping dnsutils procps locales \
    && rm -rf /var/lib/apt/lists/* \
    && localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8 \
    && localedef -i en_GB -c -f UTF-8 -A /usr/share/locale/locale.alias en_GB.UTF-8

# Active Locales
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

COPY --from=docker:29.2.1-cli /usr/local/bin/docker /usr/local/bin/

# Install Starship
# renovate: datasource=github-releases depName=starship/starship
ARG STARSHIP_VERSION=v1.24.2
RUN curl -sS https://starship.rs/install.sh | sh -s -- -y --version ${STARSHIP_VERSION}

# Install Tailscale
COPY --from=docker.io/tailscale/tailscale:v1.94.1 /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=docker.io/tailscale/tailscale:v1.94.1 /usr/local/bin/tailscale /usr/local/bin/tailscale
RUN mkdir -p /var/lib/tailscale && \
    mkdir -p /var/run/tailscale && \
    chown node:node /var/run/tailscale

WORKDIR /app
COPY package.json .

# renovate: datasource=github-releases depName=asciinema/asciinema
ARG ASCIINEMA_VERSION=v3.1.0
# Install Compilers -> Build -> Clean NPM -> Remove Compilers
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ \
        fzf zoxide bat tmux bash-completion netcat-openbsd jq eza && \
    npm install && npm cache clean --force && \
    # Install asciinema
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
        URL="https://github.com/asciinema/asciinema/releases/download/${ASCIINEMA_VERSION}/asciinema-x86_64-unknown-linux-gnu"; \
    elif [ "$ARCH" = "aarch64" ]; then \
        URL="https://github.com/asciinema/asciinema/releases/download/${ASCIINEMA_VERSION}/asciinema-aarch64-unknown-linux-gnu"; \
    else \
        echo "❌ Unsupported architecture: $ARCH" && exit 1; \
    fi && \
    curl -L -o /usr/local/bin/asciinema "$URL" && \
    chmod +x /usr/local/bin/asciinema && \
    apt-get purge -y --auto-remove python3 make g++ && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    ln -s /usr/bin/batcat /usr/local/bin/bat

COPY . .

# Copy Config Defaults
COPY config/ /usr/local/share/smart-term/defaults/

# renovate: datasource=github-tags depName=ryanoasis/nerd-fonts
ARG NERDFONT_VERSION=v3.4.0
# Setup Seed Directories & Download Font
RUN mkdir -p /usr/local/share/smart-term/fonts \
             /usr/local/share/smart-term/config && \
    curl -L -o /usr/local/share/smart-term/fonts/font.ttf \
    "https://github.com/ryanoasis/nerd-fonts/raw/${NERDFONT_VERSION}/patched-fonts/Hack/Regular/HackNerdFont-Regular.ttf"

# Configure Shell & Permissions
RUN mkdir -p /data && chown -R node:node /app /data /home/node

# Setup Entrypoint
COPY src/entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

# Metadata
ENV HOME=/home/node
EXPOSE 3939
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/index.js"]
