/**
 * Scripts de complétion bash / zsh (noms de commandes, sous-commandes, modules et actions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';

const shq = (s) => String(s).replace(/[^\w.:@,-]/g, '');

export function buildCompletion(shell, program, catalog) {
  const commands = program.commands.filter((cmd) => !cmd._hidden).flatMap((cmd) => [cmd.name(), ...cmd.aliases()]);
  let modules = catalog?.modules.map((m) => m.name) || [];
  if (!modules.length) {
    try { modules = fs.readdirSync(path.join(PROJECT_ROOT, 'src', 'modules'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { modules = []; }
  }
  const subs = program.commands.filter((cmd) => cmd.commands.length).map((cmd) => `    ${shq(cmd.name())}) words="${cmd.commands.map((s) => shq(s.name())).join(' ')}" ;;`);
  const actionsCases = (catalog?.modules || []).map((m) => `    ${shq(m.name)}) echo "${(m.actions || []).map((a) => shq(a.name)).join(' ')}" ;;`);
  const bash = `# Complétion bash pour heiphais (HeiphaisBot)
# Installation : heiphais completion bash > ~/.local/share/bash-completion/completions/heiphais
#           ou : echo 'eval "$(heiphais completion bash)"' >> ~/.bashrc
_heiphais_actions() {
  case "$1" in
${actionsCases.join('\n')}
  esac
}
_heiphais() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local cmds="${commands.map(shq).join(' ')}"
  local mods="${modules.map(shq).join(' ')}"
  local words=""
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$cmds $mods" -- "$cur") )
    return 0
  fi
  local first="\${COMP_WORDS[1]}"
  case "$first" in
    run|action|actions)
      if [ "$COMP_CWORD" -eq 2 ]; then words="$mods"; else words="$(_heiphais_actions "\${COMP_WORDS[2]}")"; fi ;;
    settings)
      if [ "$COMP_CWORD" -eq 2 ]; then words="get set reset"; else words="$mods"; fi ;;
    module)
      if [ "$COMP_CWORD" -eq 2 ]; then words="list info enable disable"; else words="$mods"; fi ;;
    completion) words="bash zsh" ;;
${subs.join('\n')}
    *)
      if [ "$COMP_CWORD" -eq 2 ]; then words="$(_heiphais_actions "$first")"; fi ;;
  esac
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
  return 0
}
complete -F _heiphais heiphais
`;
  if (shell === 'bash') return bash;
  return `#compdef heiphais
# Complétion zsh pour heiphais (via bashcompinit)
# Installation : echo 'eval "$(heiphais completion zsh)"' >> ~/.zshrc
autoload -U +X compinit && compinit
autoload -U +X bashcompinit && bashcompinit
${bash}`;
}
