import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { SUPPORTED_CLI_VERSION } from '../../src/plan/llm.js';

export function createFakeCli(directory: string) {
  const config = join(directory, 'cli-response.json');
  const record = join(directory, 'cli-requests.jsonl');
  const executable = join(directory, 'codex');
  writeFileSync(record, '');
  writeFileSync(
    executable,
    `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const config = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'));
if (args.includes('--version')) { console.log(config.version ?? ${JSON.stringify(`codex-cli ${SUPPORTED_CLI_VERSION}`)}); process.exit(0); }
if (args.includes('app-server')) {
  let buffer='';
  process.stdin.on('data',data=>{
    buffer+=data.toString();let end;
    while((end=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;const request=JSON.parse(line);
      if(request.id===1) console.log(JSON.stringify({id:1,result:{codexHome:process.env.CODEX_HOME,platformOs:'linux'}}));
      if(request.id===2) console.log(JSON.stringify(config.authError ? {id:2,error:{code:-1,message:'withheld error'}} : {id:2,result:{account:config.auth === undefined?{type:'chatgpt',planType:'plus'}:config.auth,requiresOpenaiAuth:true}}));
    }
  });
  process.stdin.on('end',()=>process.exit(config.authExit??0));
} else {
  let input = '';
  for await (const data of process.stdin) input += data.toString();
  appendFileSync(${JSON.stringify(record)}, JSON.stringify({args, input, cwd: process.cwd(), env: Object.fromEntries(['HOME','CODEX_HOME','LATCH_API_KEY','OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','NODE_OPTIONS'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))})+'\\n');
  if(config.sleep)await new Promise(resolve=>setTimeout(resolve,config.sleep));
  if(config.stderr)process.stderr.write(config.stderr);
  if(config.raw!==undefined)process.stdout.write(config.raw);
  else if(config.envelope)console.log(JSON.stringify(config.envelope));
  else {
    console.log(JSON.stringify({type:'thread.started',thread_id:'fixed-thread'}));
    console.log(JSON.stringify({type:'item.completed',item:{id:'fixed-item',type:'agent_message',text:JSON.stringify(config.response)}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}));
  }
  process.exitCode=config.exit??0;
}
`,
  );
  chmodSync(executable, 0o700);
  return {
    env: {
      HOME: directory,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
    },
    configure(value: Record<string, unknown>) {
      writeFileSync(config, JSON.stringify(value));
    },
    requests(): {
      args: string[];
      input: string;
      cwd: string;
      env: NodeJS.ProcessEnv;
    }[] {
      return readFileSync(record, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              args: string[];
              input: string;
              cwd: string;
              env: NodeJS.ProcessEnv;
            },
        );
    },
  };
}
