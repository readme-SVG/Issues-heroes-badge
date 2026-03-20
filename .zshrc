export EDITOR="vim"
export VISUAL="$EDITOR"
export PAGER="less -FRX"
export LESSHISTFILE="-"

setopt AUTO_CD
setopt HIST_IGNORE_DUPS
setopt HIST_REDUCE_BLANKS
setopt SHARE_HISTORY

HISTFILE="$HOME/.zsh_history"
HISTSIZE=50000
SAVEHIST=50000

autoload -Uz compinit
compinit

alias ll='ls -lh'
alias la='ls -lah'
alias l='ls -CF'
alias gs='git status -sb'
alias ga='git add'
alias gc='git commit'
alias gca='git commit --amend'
alias gp='git push'
alias gl='git pull --ff-only'
alias gd='git diff'
alias gco='git checkout'
alias gcb='git checkout -b'
alias ..='cd ..'
alias ...='cd ../..'
alias c='clear'

if command -v rg >/dev/null 2>&1; then
  alias grep='rg'
fi

if command -v eza >/dev/null 2>&1; then
  alias ls='eza --group-directories-first'
fi
