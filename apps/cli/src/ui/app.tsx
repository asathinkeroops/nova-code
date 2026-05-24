import React from "react";
import { Box, Static, Text, useInput } from "ink";
import { useShallow } from "zustand/react/shallow";
import { ApprovalPrompt } from "./approval.js";
import { AskPanel } from "./ask-user.js";
import { InputBox } from "./input-box.js";
import { Messages } from "./messages.js";
import { PickHorizontal, PickList } from "./picker.js";
import { Spinner } from "./spinner.js";
import type { AppStoreApi, ModalState } from "./store.js";
import { TodoFooter } from "./todo-footer.js";

interface EscWatcherProps {
  onInterrupt: () => void;
}

function EscWatcher({ onInterrupt }: EscWatcherProps): null {
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onInterrupt();
    }
  });
  return null;
}

interface ModalViewProps {
  modal: ModalState;
  resolveModal: (value: unknown) => void;
}

function ModalView({ modal, resolveModal }: ModalViewProps): React.ReactElement | null {
  switch (modal.kind) {
    case "input":
      return (
        <InputBox
          options={modal.opts}
          onSubmit={(value) => resolveModal(value)}
          onCancel={() => resolveModal(null)}
        />
      );
    case "approval":
      return (
        <ApprovalPrompt
          decision={modal.decision}
          input={modal.input}
          {...(modal.onCancel ? { onCancel: modal.onCancel } : {})}
          onAnswer={(value) => resolveModal(value)}
        />
      );
    case "ask":
      return <AskPanel req={modal.req} onResolve={(value) => resolveModal(value)} />;
    case "pick":
      return <PickList opts={modal.opts} onResolve={(value) => resolveModal(value)} />;
    case "pickH":
      return <PickHorizontal opts={modal.opts} onResolve={(value) => resolveModal(value)} />;
    default:
      return null;
  }
}

interface AppProps {
  store: AppStoreApi;
}

export function App({ store }: AppProps): React.ReactElement {
  const { history, messages, thinkingLabel, todos, spinner, modal, escHandler } = store(
    useShallow((s) => ({
      history: s.history,
      messages: s.messages,
      thinkingLabel: s.thinkingLabel,
      todos: s.todos,
      spinner: s.spinner,
      modal: s.modal,
      escHandler: s.escHandler,
    })),
  );
  // Actions are stable across renders — grab them once via getState().
  const resolveModal = store.getState().resolveModal;

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(block, i) =>
          typeof block === "string" ? (
            <Text key={i}>{block}</Text>
          ) : (
            <React.Fragment key={i}>{block}</React.Fragment>
          )
        }
      </Static>
      <Messages
        messages={messages}
        {...(thinkingLabel !== undefined ? { thinkingLabel } : {})}
      />
      {modal ? (
        <ModalView modal={modal} resolveModal={resolveModal} />
      ) : (
        <Box flexDirection="column">
          {spinner && todos.length === 0 ? <Spinner spec={spinner} /> : null}
          <TodoFooter todos={todos} />
          {escHandler ? <EscWatcher onInterrupt={escHandler} /> : null}
        </Box>
      )}
    </Box>
  );
}
