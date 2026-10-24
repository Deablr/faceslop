// Mutation hooks. Each keeps the affected caches correct (optimistic where it's cheap and safe).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { appLogin, appLogout } from '@/server/functions/app-auth';
import { cancelLogin, getAuthStatus, login, logout, submitLoginCode } from '@/server/functions/auth';
import { blockSeller, unblockSeller } from '@/server/functions/blocked-sellers';
import { addFavorite, removeFavorite } from '@/server/functions/favorites';
import { clearHidden, hideListing, unhideListing } from '@/server/functions/hidden';
import { sendMessage } from '@/server/functions/messaging';
import { closeRemoteView, openRemoteView } from '@/server/functions/remote-view';
import { createSavedSearch, deleteSavedSearch, updateSavedSearch } from '@/server/functions/saved-searches';
import { updateSettings } from '@/server/functions/settings';
import { onSessionChanged, onUnlocked, storeAuthStatus } from '@/lib/account-change';
import { queryKeys, removeCachedListings } from '@/lib/queries';
import type {
  AppAuthStatus,
  AuthStatus,
  BlockedSellerInput,
  Favorite,
  HiddenListingInput,
  ListingSummary,
  LoginRequest,
  SavedSearch,
  SavedSearchInputEncoded,
  SavedSearchPatch,
  Settings,
  SettingsPatch,
} from '@/shared/domain';
import { CLOSED_REMOTE_VIEW_STATE, type OpenRemoteViewRequest, type RemoteViewState } from '@/shared/remote-view';

/** Just the summary fields, so favoriting from the item page doesn't post the whole description. */
export function toSummary(listing: ListingSummary): ListingSummary {
  const { id, title, price, previousPrice, imageUrl, location, createdAt, status, sellerId, sellerName, deliveryTypes, categoryId, url } =
    listing;
  return { id, title, price, previousPrice, imageUrl, location, createdAt, status, sellerId, sellerName, deliveryTypes, categoryId, url };
}

// ---------- library ----------

export interface ToggleFavoriteInput {
  readonly listing: ListingSummary;
  readonly favorited: boolean;
}

export function useToggleFavorite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ listing, favorited }: ToggleFavoriteInput): Promise<void> => {
      if (favorited) await removeFavorite({ data: { listingId: listing.id } });
      else await addFavorite({ data: { listing: toSummary(listing) } });
    },
    onMutate: async ({ listing, favorited }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.favorites });
      const previous = queryClient.getQueryData<readonly Favorite[]>(queryKeys.favorites);
      queryClient.setQueryData<readonly Favorite[]>(queryKeys.favorites, (list = []) =>
        favorited
          ? list.filter((f) => f.listing.id !== listing.id)
          : [{ listing: toSummary(listing), savedAt: Date.now(), originalPrice: listing.price, lastCheckedAt: null, note: null }, ...list],
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      queryClient.setQueryData(queryKeys.favorites, context?.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.favorites }),
  });
}

export function useHideListing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (listing: HiddenListingInput) => hideListing({ data: listing }),
    onSuccess: (_hidden, { id }) => {
      removeCachedListings(queryClient, (l) => l.id === id);
      return queryClient.invalidateQueries({ queryKey: queryKeys.hidden });
    },
  });
}

export function useUnhideListing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unhideListing({ data: { id } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.hidden }),
  });
}

export function useClearHidden() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => clearHidden(),
    onSuccess: () => {
      queryClient.setQueryData(queryKeys.hidden, []);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.hidden }),
  });
}

export function useBlockSeller() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (seller: BlockedSellerInput) => blockSeller({ data: seller }),
    onSuccess: (_blocked, { id }) => {
      removeCachedListings(queryClient, (l) => l.sellerId === id);
      return queryClient.invalidateQueries({ queryKey: queryKeys.blockedSellers });
    },
  });
}

export function useUnblockSeller() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unblockSeller({ data: { id } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.blockedSellers }),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => updateSettings({ data: patch }),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.settings });
      const previous = queryClient.getQueryData<Settings>(queryKeys.settings);
      if (previous !== undefined) queryClient.setQueryData<Settings>(queryKeys.settings, { ...previous, ...patch });
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(queryKeys.settings, context.previous);
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.settings, settings);
    },
  });
}

// ---------- saved searches ----------

export function useCreateSavedSearch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SavedSearchInputEncoded) => createSavedSearch({ data: input }),
    onSuccess: (saved) => {
      queryClient.setQueryData<readonly SavedSearch[]>(queryKeys.savedSearches, (list) => (list ? [saved, ...list] : list));
      return queryClient.invalidateQueries({ queryKey: queryKeys.savedSearches });
    },
  });
}

export interface UpdateSavedSearchVars {
  readonly id: number;
  readonly patch: SavedSearchPatch;
}

export function useUpdateSavedSearch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateSavedSearchVars) => updateSavedSearch({ data: { id, patch } }),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.savedSearches });
      const previous = queryClient.getQueryData<readonly SavedSearch[]>(queryKeys.savedSearches);
      queryClient.setQueryData<readonly SavedSearch[]>(queryKeys.savedSearches, (list) =>
        list?.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      queryClient.setQueryData(queryKeys.savedSearches, context?.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.savedSearches }),
  });
}

export function useDeleteSavedSearch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteSavedSearch({ data: { id } }),
    onSuccess: (_ok, id) => {
      queryClient.setQueryData<readonly SavedSearch[]>(queryKeys.savedSearches, (list) => list?.filter((s) => s.id !== id));
      queryClient.removeQueries({ queryKey: queryKeys.savedSearchRun(id) });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.savedSearches }),
  });
}

// ---------- messaging ----------

export function useSendMessage(listingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => sendMessage({ data: { listingId, text } }),
    onSuccess: (result) => {
      // The listing now carries hasMessaged; refetch it next time it's shown.
      if (result.ok) void queryClient.invalidateQueries({ queryKey: queryKeys.listing(listingId), refetchType: 'none' });
    },
  });
}

// ---------- remote view ----------

/** Opens (or retargets) the remote view; the viewer derives from the cached remote-view state. */
export function useOpenRemoteView() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: OpenRemoteViewRequest) => openRemoteView({ data: request }),
    onSuccess: (state) => {
      queryClient.setQueryData<RemoteViewState>(queryKeys.remoteView, state);
    },
  });
}

/**
 * Closes the remote view ("Done"). The server saves the view's Facebook cookies and, like every session
 * change, resets search sessions and cached listing details (decision 4).
 */
export function useCloseRemoteView() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => closeRemoteView(),
    onSettled: (state) => {
      queryClient.setQueryData<RemoteViewState>(queryKeys.remoteView, state ?? CLOSED_REMOTE_VIEW_STATE);
      onSessionChanged(queryClient);
    },
  });
}

// ---------- Facebook auth ----------

/**
 * Every auth call returns the new AuthStatus; store it so polling and the top bar react at once.
 * A login or logout changes whose data this browser shows (src/lib/account-change.ts). The status
 * the call started from is kept, so a result that returns after a newer one isn't stored over it.
 */
function useAuthMutation<TVars>(mutationFn: (vars: TVars) => Promise<AuthStatus>, gcTime?: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    ...(gcTime === undefined ? {} : { gcTime }),
    onMutate: () => ({ startedFrom: queryClient.getQueryData<AuthStatus>(queryKeys.auth) }),
    onSuccess: (status, _vars, { startedFrom }) => {
      storeAuthStatus(queryClient, status, startedFrom);
    },
  });
}

/** gcTime 0: don't keep the submitted credentials in the mutation cache after the form goes away. */
export const usePasswordLogin = () => useAuthMutation((body: LoginRequest) => login({ data: body }), 0);
export const useSubmitLoginCode = () => useAuthMutation((code: string) => submitLoginCode({ data: { code } }));
/** Give up on the login in progress here (back to the login options). */
export const useCancelLogin = () => useAuthMutation(() => cancelLogin());
/** Log out of Facebook on this device only; other devices logged in to the account stay connected. */
export const useFacebookLogout = () => useAuthMutation(() => logout());
/** One live check against Facebook (user-initiated): is the saved session still good? */
export const useVerifyFacebookSession = () => useAuthMutation(() => getAuthStatus({ data: { verify: true } }));

// ---------- app password ----------

export function useAppLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => appLogin({ data: { password } }),
    gcTime: 0,
    onSuccess: (status) => {
      // A wrong password fails with FORBIDDEN, so success always means unlocked (with no expiry:
      // until this browser is locked again).
      queryClient.setQueryData<AppAuthStatus>(queryKeys.appAuth, status);
      // Everything that loaded while locked failed, and the browser may already be logged in to
      // Facebook: load it all again, without replaying Facebook searches.
      onUnlocked(queryClient);
    },
  });
}

/** Lock faceslop on this browser. Its Facebook connection and data stay; the app password unlocks it again. */
export function useAppLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => appLogout(),
    onSuccess: (status) => {
      queryClient.setQueryData<AppAuthStatus>(queryKeys.appAuth, status);
    },
  });
}
