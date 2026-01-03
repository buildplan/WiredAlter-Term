# Use Node.js 25 on Debian 13
FROM node:25-trixie-slim

# Install Runtime Dependencies (Keep these)
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    gosu \
    git \
    openssh-client \
    vim \
    nano \
    curl \
    wget \
    unzip \
    htop \
    ca-certificates \
    iputils-ping \
    dnsutils \
    procps \
    locales \
    # Install Build Dependencies (Temp)
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/* \
    && localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8 \
    && localedef -i en_GB -c -f UTF-8 -A /usr/share/locale/locale.alias en_GB.UTF-8

# Active Locale to UK
ENV LANG=en_GB.utf8
ENV LANGUAGE=en_GB:en
ENV LC_ALL=en_GB.utf8

COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/

# Install Starship
RUN curl -sS https://starship.rs/install.sh | sh -s -- -y

WORKDIR /app
COPY package.json .

# Install Node Modules AND Remove Build Tools
RUN npm install && \
    apt-get purge -y --auto-remove python3 make g++ && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY . .

# Setup Seed Directories & Download Font
RUN mkdir -p /usr/local/share/smart-term/fonts \
             /usr/local/share/smart-term/config && \
    curl -L -o /usr/local/share/smart-term/fonts/font.ttf \
    "https://github.com/ryanoasis/nerd-fonts/raw/master/patched-fonts/Hack/Regular/HackNerdFont-Regular.ttf"

# Configure Shell & Permissions
RUN echo 'eval "$(starship init bash)"' >> /home/node/.bashrc && \
    mkdir -p /data && \
    chown -R node:node /app /data /home/node/.bashrc

# Setup Entrypoint
COPY src/entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

# Metadata
ENV HOME=/home/node
EXPOSE 3939
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/index.js"]
