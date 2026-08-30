import { useCallback, useEffect, useState } from 'react';
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
import {
  detectAndEnableDebug,
  HOSTNAME_EXPRESSION,
  type PageEvaluator,
  type SdkStatus,
  type Wait,
} from '../../shared/sdk';
import { ColumnMappingForm } from './components/ColumnMappingForm';
import { EventTree } from './components/EventTree';
import { SdkStatusBar } from './components/SdkStatusBar';
import { SheetUpload } from './components/SheetUpload';

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
}

export function App({ evaluator, wait }: AppProps) {
  const [hostname, setHostname] = useState('');
  const [sdk, setSdk] = useState<SdkStatus | undefined>(undefined);
  const [sheetState, setSheetState] = useState<SheetState>({ kind: 'empty' });

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
