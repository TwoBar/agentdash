import { useState, type FormEvent } from "react";
import type {
  Persona,
  SkillVersion,
} from "../../../packages/domain/src/index.js";
import { ApiFailure, LocalApi } from "./api.js";

const coordinationTools = [
  "get_task_context",
  "resolve_artifact",
  "register_artifact",
  "request_subagent",
  "get_child_status",
  "reply_to_child",
  "report_status",
  "request_decision",
];
const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
type Actions = {
  api: LocalApi;
  busy: boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  notify: (message: string) => void;
};

export function PersonaEditor({
  source,
  skills,
  api,
  busy,
  run,
  notify,
}: Actions & { source: Persona; skills: SkillVersion[] }) {
  const [name, setName] = useState(`${source.name} copy`);
  const [mandate, setMandate] = useState(source.mandate);
  const [instructions, setInstructions] = useState(source.instructions);
  const [tools, setTools] = useState(new Set(source.toolScope || []));
  const [dataScope, setDataScope] = useState(
    (source.dataScope || []).join("\n"),
  );
  const [escalation, setEscalation] = useState(
    (source.escalationRules || []).join("\n"),
  );
  const [outputs, setOutputs] = useState(
    (source.expectedOutputs || []).join("\n"),
  );
  const [completion, setCompletion] = useState(source.completionContract || "");
  const [required, setRequired] = useState(source.requiredArtifacts.join("\n"));
  const [attached, setAttached] = useState(
    new Set(source.skillVersionIds || []),
  );
  const toggle = (
    value: string,
    set: (next: Set<string>) => void,
    current: Set<string>,
  ) => {
    const next = new Set(current);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    set(next);
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await api.post(
        "/personas",
        {
          sourceId: source.id,
          name,
          mandate,
          instructions,
          toolScope: [...tools],
          dataScope: lines(dataScope),
          escalationRules: lines(escalation),
          expectedOutputs: lines(outputs),
          completionContract: completion,
          requiredArtifacts: lines(required),
          skillVersionIds: [...attached],
        },
        "Save persona version",
      );
      notify(
        "New immutable persona version created. Running sessions retain their pinned persona, skill versions, and context digest.",
      );
    });
  }
  return (
    <div className="persona-editing">
      <form className="clone-form" onSubmit={(event) => void submit(event)}>
        <h3>Create an immutable version</h3>
        <p className="form-note">
          Changes apply only to future sessions. Authority stays human-only;
          instructions cannot grant native approval or task acceptance.
        </p>
        <label>
          Name
          <input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
          />
        </label>
        <label>
          Mandate
          <textarea
            required
            rows={3}
            value={mandate}
            onChange={(event) => setMandate(event.target.value)}
          />
        </label>
        <label>
          Instructions
          <textarea
            required
            rows={6}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <fieldset className="metadata-checklist">
          <legend>Permitted coordination tools</legend>
          {coordinationTools.map((tool) => (
            <label key={tool}>
              <input
                type="checkbox"
                checked={tools.has(tool)}
                onChange={() => toggle(tool, setTools, tools)}
              />
              <code>{tool}</code>
            </label>
          ))}
        </fieldset>
        <label>
          Data scope <small>One declared scope per line</small>
          <textarea
            required
            rows={3}
            value={dataScope}
            onChange={(event) => setDataScope(event.target.value)}
          />
        </label>
        <label>
          Escalation rules <small>One rule per line</small>
          <textarea
            required
            rows={3}
            value={escalation}
            onChange={(event) => setEscalation(event.target.value)}
          />
        </label>
        <label>
          Required artifact inputs{" "}
          <small>
            One logical key per line; leave empty if this role requires none
          </small>
          <textarea
            rows={3}
            value={required}
            onChange={(event) => setRequired(event.target.value)}
          />
        </label>
        <label>
          Expected outputs <small>One output per line</small>
          <textarea
            required
            rows={3}
            value={outputs}
            onChange={(event) => setOutputs(event.target.value)}
          />
        </label>
        <label>
          Completion contract
          <textarea
            required
            rows={3}
            value={completion}
            onChange={(event) => setCompletion(event.target.value)}
          />
        </label>
        <fieldset className="metadata-checklist">
          <legend>Attached skill versions</legend>
          {skills.length ? (
            skills.map((skill) => (
              <label key={skill.id}>
                <input
                  type="checkbox"
                  checked={attached.has(skill.id)}
                  onChange={() => toggle(skill.id, setAttached, attached)}
                />
                <span>
                  {skill.name} · v{skill.version}
                  <small>{skill.procedure}</small>
                </span>
              </label>
            ))
          ) : (
            <p className="muted small">
              No reusable skill versions are available.
            </p>
          )}
        </fieldset>
        <button className="button" disabled={busy}>
          Save new persona version
        </button>
      </form>
      <details className="skill-editor-details">
        <summary>Create or version a reusable skill</summary>
        <SkillEditor
          skills={skills}
          api={api}
          busy={busy}
          run={run}
          notify={notify}
        />
      </details>
    </div>
  );
}

function SkillEditor({
  skills,
  api,
  busy,
  run,
  notify,
}: Actions & { skills: SkillVersion[] }) {
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [procedure, setProcedure] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [input, setInput] = useState("{}");
  const [output, setOutput] = useState("{}");
  function choose(id: string) {
    setSourceId(id);
    const source = skills.find((skill) => skill.id === id);
    if (source) {
      setName(source.name);
      setProcedure(source.procedure);
      setCapabilities(source.requiredCapabilities.join("\n"));
      setInput(JSON.stringify(source.inputSchema, null, 2));
      setOutput(JSON.stringify(source.outputSchema, null, 2));
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      let inputSchema: unknown, outputSchema: unknown;
      try {
        inputSchema = JSON.parse(input);
        outputSchema = JSON.parse(output);
      } catch {
        throw new ApiFailure(
          "Input and output schemas must be valid JSON objects. Your draft is kept.",
          "invalid_skill_schema",
          "Save skill version",
          400,
          false,
          { schemas: "Correct the JSON syntax before saving." },
        );
      }
      if (
        !inputSchema ||
        typeof inputSchema !== "object" ||
        Array.isArray(inputSchema) ||
        !outputSchema ||
        typeof outputSchema !== "object" ||
        Array.isArray(outputSchema)
      )
        throw new ApiFailure(
          "Skill schemas must be JSON objects.",
          "invalid_skill_schema",
          "Save skill version",
        );
      await api.post(
        "/skills",
        {
          ...(sourceId ? { sourceId } : {}),
          name,
          procedure,
          requiredCapabilities: lines(capabilities),
          inputSchema,
          outputSchema,
        },
        "Save skill version",
      );
      notify(
        "Immutable skill version saved. Attach its exact version to one or more new persona versions.",
      );
    });
  }
  return (
    <form className="clone-form" onSubmit={(event) => void submit(event)}>
      <label>
        Version an existing skill or start fresh
        <select
          value={sourceId}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="">New reusable skill</option>
          {skills.map((skill) => (
            <option value={skill.id} key={skill.id}>
              {skill.name} · v{skill.version}
            </option>
          ))}
        </select>
      </label>
      <label>
        Skill name
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={100}
        />
      </label>
      <label>
        Procedure
        <textarea
          required
          rows={5}
          value={procedure}
          onChange={(event) => setProcedure(event.target.value)}
        />
      </label>
      <label>
        Required capabilities <small>One capability per line</small>
        <textarea
          rows={3}
          value={capabilities}
          onChange={(event) => setCapabilities(event.target.value)}
        />
      </label>
      <label>
        Input JSON schema
        <textarea
          required
          rows={4}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          spellCheck={false}
        />
      </label>
      <label>
        Output JSON schema
        <textarea
          required
          rows={4}
          value={output}
          onChange={(event) => setOutput(event.target.value)}
          spellCheck={false}
        />
      </label>
      <button className="button" disabled={busy}>
        Save immutable skill version
      </button>
    </form>
  );
}

export function PersonaMetadata({
  persona,
  skills,
}: {
  persona: Persona;
  skills: SkillVersion[];
}) {
  const references = (persona.skillVersionIds || []).map((id) =>
    skills.find((skill) => skill.id === id),
  );
  return (
    <>
      <dl className="facts">
        <dt>Authority template</dt>
        <dd>
          {persona.authorityTemplate?.mode || "Unavailable"}
          {persona.authorityTemplate?.capabilities.length
            ? ` · ${persona.authorityTemplate.capabilities.join(", ")}`
            : ""}
        </dd>
        <dt>Tool scope</dt>
        <dd>{persona.toolScope?.join(", ") || "No tool scope declared"}</dd>
        <dt>Data scope</dt>
        <dd>{persona.dataScope?.join("; ") || "No data scope declared"}</dd>
        <dt>Escalation</dt>
        <dd>{persona.escalationRules?.join("; ") || "Unavailable"}</dd>
        <dt>Expected outputs</dt>
        <dd>{persona.expectedOutputs?.join("; ") || "Unavailable"}</dd>
        <dt>Completion</dt>
        <dd>{persona.completionContract || "Unavailable"}</dd>
      </dl>
      <div className="subheading">Pinned reusable procedures</div>
      {references.length ? (
        references.map((skill, index) =>
          skill ? (
            <details className="skill-detail" key={skill.id}>
              <summary>
                {skill.name} · v{skill.version}
              </summary>
              <pre className="content-text">{skill.procedure}</pre>
              <p className="muted small">
                Capabilities: {skill.requiredCapabilities.join(", ") || "None"}
              </p>
              <details>
                <summary>Input/output contracts</summary>
                <pre>
                  {JSON.stringify(
                    { input: skill.inputSchema, output: skill.outputSchema },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </details>
          ) : (
            <p className="evidence-gap" key={index}>
              A referenced skill version is unavailable.
            </p>
          ),
        )
      ) : (
        <p className="muted small">No exact skill versions are attached.</p>
      )}
    </>
  );
}
