import { useEffect } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { WorkspaceProvider } from './contexts/WorkspaceContext';
import { ToastProvider, useToast } from './components/ui/Toast';
import { LoginScreen } from './components/Login/LoginScreen';
import { IDELayout } from './components/Layout/IDELayout';
import { UpdateDialog, WhatsNewDialog } from './components/UpdateDialog/UpdateDialog';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import { SettingsDialog } from './components/Settings/SettingsDialog';
import { QuickOpen } from './components/QuickOpen/QuickOpen';
import { SearchInFiles } from './components/SearchInFiles/SearchInFiles';
import { CompareDialog } from './components/Editor/CompareDialog';
import { BranchPickerHost } from './components/Sidebar/BranchPicker';
import { GitLogHost } from './components/Sidebar/GitLogModal';
import { SquadModal } from './components/AI/SquadModal';
import { Spinner } from './components/ui/Spinner';
import { AtelierIconSprite } from './components/ui/AtelierIcon';

/** v0.11.13: bridge between AuthContext (which dispatches a window
 *  CustomEvent because it lives outside the Toast tree) and the
 *  Toast hook. Mounted under <ToastProvider> so useToast() works. */
function StorageWarningBridge() {
  const toast = useToast();
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ title: string; body: string }>).detail;
      if (detail) toast.error(detail.title, detail.body);
    };
    window.addEventListener('suxai:storage-warning', handler);
    return () => window.removeEventListener('suxai:storage-warning', handler);
  }, [toast]);
  return null;
}

function Root() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div
        className="stack"
        style={{ height: '100%', alignItems: 'center', justifyContent: 'center' }}
      >
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <>
      <AtelierIconSprite />
      {status === 'authenticated' ? <IDELayout /> : <LoginScreen />}
      <UpdateDialog />
      <WhatsNewDialog />
      <CommandPalette />
      <SettingsDialog />
      <QuickOpen />
      <SearchInFiles />
      <CompareDialog />
      <BranchPickerHost />
      <GitLogHost />
      <SquadModal />
      <StorageWarningBridge />
    </>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <WorkspaceProvider>
          <Root />
        </WorkspaceProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
