import { useCallback, useEffect, useMemo, useState } from 'react';
import { detectColumns } from '../../event-sheet/detect-columns';
import { EventSheetError } from '../../event-sheet/errors';
import { normalizeSheet } from '../../event-sheet/normalize';
import { parseCsv } from '../../event-sheet/parse-csv';
import { readWorkbook } from '../../event-sheet/parse-xlsx';
import type {
  ColumnDetection,
  ColumnMapping,
  EventSheet,
  SheetGrid,
} from '../../event-sheet/types';
import type {
  CaptureStats,
  CapturedPayload,
  PayloadSource,
  TransferableValue,
} from '../../shared/payload';
import {
  detectAndEnableDebug,
  HOSTNAME_EXPRESSION,
  type PageEvaluator,
  type SdkStatus,
  type Wait,
} from '../../shared/sdk';
import type { PageDriver } from '../../automation/commands';
import type { NavigationSource } from './chrome-navigation';
import { verdictFor, type CaptureVerdict } from '../../validation/from-capture';
import { ColumnMappingForm } from './components/ColumnMappingForm';
import { EventTree } from './components/EventTree';
import { PageSweep } from './components/PageSweep';
import { PastePayloads } from './components/PastePayloads';
import { TestRunner } from './components/TestRunner';
import { PayloadStream } from './components/PayloadStream';
import { SdkStatusBar } from './components/SdkStatusBar';
import { SheetUpload } from './components/SheetUpload';

/** Bounded so a long session on a chatty page cannot grow the panel's memory without limit. */
const MAX_PAYLOADS = 500;

type AmbiguousDetection = Extract<ColumnDetection, { kind: 'ambiguous' }>;

type SheetState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'mapping';
      readonly grid: SheetGrid;
      readonly detection: AmbiguousDetection;
      readonly fileName: string;
    }
  | { readonly kind: 'ready'; readonly sheet: EventSheet; readonly fileName: string };

export interface AppProps {
  readonly evaluator: PageEvaluator;
  readonly wait: Wait;
  readonly payloadSource: PayloadSource;
  readonly driver: PageDriver;
  readonly navigation: NavigationSource;
  readonly now: () => number;
  /** Saves a generated report. Injected because touching the DOM is the root's job, not a component's. */
  readonly download: (contents: string, fileName: string) => void;
}

export function App({
  evaluator,
  wait,
  payloadSource,
  driver,
  navigation,
  now,
  download,
}: AppProps) {
  const [hostname, setHostname] = useState('');
  const [sdk, setSdk] = useState<SdkStatus | undefined>(undefined);
  const [sheetState, setSheetState] = useState<SheetState>({ kind: 'empty' });
  const [payloads, setPayloads] = useState<readonly CapturedPayload[]>([]);
  const [stats, setStats] = useState<CaptureStats | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const probe = async (): Promise<void> => {
      const location = await evaluator.evaluate(HOSTNAME_EXPRESSION);
      if (!cancelled && location.kind === 'value' && typeof location.value === 'string') {
        setHostname(location.value);
      }

      const status = await detectAndEnableDebug(evaluator, wait);
      if (!cancelled) {
        setSdk(status);
      }
    };

    void probe();

    return () => {
      cancelled = true;
    };
  }, [evaluator, wait]);

  useEffect(() => payloadSource.subscribeStats(setStats), [payloadSource]);

  useEffect(
    () =>
      payloadSource.subscribe((payload) => {
        // Newest first, oldest discarded past the cap.
        setPayloads((current) => [payload, ...current].slice(0, MAX_PAYLOADS));
      }),
    [payloadSource],
  );

  // Verdicts are derived, never stored: the sheet or the payload list changing recomputes them.
  const verdicts = useMemo<ReadonlyMap<string, CaptureVerdict>>(() => {
    if (sheetState.kind !== 'ready') {
      return new Map();
    }
    return new Map(payloads.map((payload) => [payload.id, verdictFor(payload, sheetState.sheet)]));
  }, [payloads, sheetState]);

  const addPastedPayloads = (values: readonly TransferableValue[]): void => {
    const at = now();
    const pasted: CapturedPayload[] = values.map((value, index) => ({
      id: `pasted-${at}-${index}`,
      at,
      args: [value],
      raw: JSON.stringify([value]),
      origin: 'pasted',
    }));

    setPayloads((current) => [...pasted.reverse(), ...current].slice(0, MAX_PAYLOADS));
  };

  const handleFile = useCallback(async (file: File): Promise<void> => {
    try {
      const grid = await readGrid(file);
      const detection = detectColumns(grid);

      if (detection.kind === 'ambiguous') {
        setSheetState({ kind: 'mapping', grid, detection, fileName: file.name });
        return;
      }

      setSheetState({
        kind: 'ready',
        fileName: file.name,
        sheet: normalizeSheet(grid, detection.mapping, detection.headerRow),
      });
    } catch (error) {
      setSheetState({
        kind: 'failed',
        message:
          error instanceof EventSheetError
            ? error.message
            : `${file.name} could not be read as a spreadsheet.`,
      });
    }
  }, []);

  const applyMapping = (mapping: ColumnMapping): void => {
    if (sheetState.kind !== 'mapping') {
      return;
    }

    setSheetState({
      kind: 'ready',
      fileName: sheetState.fileName,
      sheet: normalizeSheet(sheetState.grid, mapping, sheetState.detection.headerRow),
    });
  };

  return (
    <main className="panel">
      <h1>Smartech Event Validator</h1>

      <SdkStatusBar hostname={hostname} status={sdk} />

      <SheetUpload
        onFile={(file) => void handleFile(file)}
        fileName={sheetState.kind === 'empty' || sheetState.kind === 'failed' ? undefined : sheetState.fileName}
        error={sheetState.kind === 'failed' ? sheetState.message : undefined}
      />

      {sheetState.kind === 'mapping' ? (
        <ColumnMappingForm
          headers={sheetState.detection.headers}
          candidates={sheetState.detection.candidates}
          missing={sheetState.detection.missing}
          onSubmit={applyMapping}
        />
      ) : null}

      {sheetState.kind === 'ready' ? <EventTree sheet={sheetState.sheet} /> : null}

      <PageSweep
        driver={driver}
        sheet={sheetState.kind === 'ready' ? sheetState.sheet : undefined}
        payloads={payloads}
        now={now}
        navigation={navigation}
        site={hostname}
        sheetName={sheetState.kind === 'ready' ? sheetState.fileName : ''}
        sdkReady={sdk?.kind === 'ready'}
        onExport={download}
      />

      <TestRunner
        driver={driver}
        sheet={sheetState.kind === 'ready' ? sheetState.sheet : undefined}
        payloads={payloads}
        sdkReady={sdk === undefined ? undefined : sdk.kind === 'ready'}
        sdkDiagnostic={sdk?.kind === 'absent' ? sdk.diagnostic : undefined}
        now={now}
      />

      <PayloadStream
        payloads={payloads}
        verdicts={verdicts}
        stats={stats}
        onClear={() => {
          setPayloads([]);
        }}
      />

      <PastePayloads onParsed={addPastedPayloads} />
    </main>
  );
}

/**
 * Reads whichever format was uploaded. Workbooks fall back to the first worksheet;
 * choosing among multiple sheets is not part of Phase 1.
 */
async function readGrid(file: File): Promise<SheetGrid> {
  if (file.name.toLowerCase().endsWith('.csv')) {
    return parseCsv(await file.text());
  }

  const worksheets = await readWorkbook(file);
  const first = worksheets[0];
  if (first === undefined) {
    throw new EventSheetError('The workbook contains no worksheets.');
  }

  return first.grid;
}
